import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  loadEntries,
  loadNotes,
  loadSummaries,
  saveNotes,
  activeEntries,
  autoReclaim,
  migrateFromCtxLite,
} from './storage.ts'
import { registerTools } from './tools.ts'
import { registerCommands } from './commands.ts'
import { buildInjectionBlock, INJECT_TAG, filterInjectedMessages } from './inject.ts'
import { extractConversation, extractTextFromEntries, isExtractWorker, processPendingExtracts, queuePendingExtract } from './extract.ts'
import { writeCompactionSnapshot } from './snapshot.ts'
import { resetOutputBudget } from '../../lib/prune.ts'

export default function (pi: ExtensionAPI): void {
  registerTools(pi)
  registerCommands(pi)

  // ── 启动迁移报告 + compaction 恢复检测 ──
  pi.on('session_start', async (_event, ctx) => {
    // 提取子进程守卫（审计修复 HIGH-3）：extract.ts spawn 的 `pi -p` 子进程
    // 加载扩展会触发本回调，与父进程并发消费 pending 队列（抢锁失败按失败计数，
    // 可误删父进程未处理 job）。子进程不消费 pending，只做提取执行。
    if (isExtractWorker()) {
      resetOutputBudget()
      return
    }
    // 会话边界重置输出预算（recordOutput/pruneToolOutput 的累计输出量；
    // 与 pi-web-search/pi-browser 的 session_start 对齐，防跨会话预算串味）
    resetOutputBudget()
    migrateFromCtxLite()
    const notes = loadNotes()
    const noteCount = Object.keys(notes).filter(k => !k.startsWith('__') && !k.startsWith('_ctx.')).length

    const compactedAt = notes['_ctx.compacted_at']
    if (compactedAt) {
      const age = Date.now() - new Date(compactedAt).getTime()
      if (age < 30_000) {
        notes['_ctx.just_compacted'] = 'true'
        saveNotes(notes)
      }
    }

    // 消费上次退出时入队的延迟提取（后台执行，不阻塞启动）
    // 注意：异步回调里不可用 ctx（session 可能已被替换 → stale ctx 抛错），先捕获 hasUI
    const hasUI = ctx.hasUI
    const notify = ctx.ui?.notify
    void processPendingExtracts().then(({ ok, failed }) => {
      if (ok > 0 && hasUI && notify) {
        notify(`pi-memory: 已补提取 ${ok} 个待处理会话${failed > 0 ? `（${failed} 个失败保留）` : ''}`, 'info')
      }
    })

    if (noteCount > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `pi-memory: ${noteCount} 笔记 · ${activeEntries(loadEntries()).length} 记忆已就绪（已合并 ctx-lite）`,
        'info',
      )
    }
  })

  // ── 每轮常驻注入（MemGPT 核心块） ──
  // 缓存友好（2026-08-14 实测）：记忆注入原先拼入 systemPrompt 尾部——记忆库变化
  // （memory_store/提取/摘要更新）时 system prompt 尾部变化，缓存前缀断裂，
  // 全部消息历史（~72K）每轮重发。改为消息注入（追加在消息末尾）：变化时
  // 仅重发注入块本身（≤500 token），历史全命中。context hook 过滤旧注入防累积。
  pi.on('before_agent_start', async (_event, _ctx) => {
    let entries = loadEntries()
    // 自动回收 deleted 软删条目（条目数超阈值时；无界增长审计修复）
    // 2026-08 审计：autoReclaim 返回清理后的数组，须承接——否则后续调用方若沿用
    // 含 deleted 的原数组再 saveEntries 会把已回收条目标记合并回磁盘（防复活）
    const kept = autoReclaim(entries)
    if (kept) entries = kept
    const summaries = loadSummaries()
    const { block, entries: n, summaries: m } = buildInjectionBlock(entries, summaries)
    if (n === 0 && m === 0) return undefined
    return {
      message: {
        customType: INJECT_TAG,
        content: block,
        display: false,
      },
    }
  })

  // 过滤历史注入消息：同 customType 只保留最新一条（对齐 plan-mode 模式），
  // 防止注入消息累积进上下文（2.4.0 同类 bug）；请求序列每轮结构一致，缓存前缀稳定。
  pi.on('context', async (event) => {
    return { messages: filterInjectedMessages(event.messages) }
  })

  // ── compaction 前: 快照 + 异步提取 ──
  pi.on('session_before_compact', async (_event, ctx) => {
    const notes = loadNotes()
    notes['_ctx.compacted_at'] = new Date().toISOString()
    saveNotes(notes)

    writeCompactionSnapshot(ctx)
    // 异步提取，不阻塞 compaction
    void extractFromSession(ctx)
  })

  // ── 会话结束: 提取（入队延迟到下次启动，避免阻塞退出） ──
  pi.on('session_shutdown', (_event, ctx) => {
    // 提取子进程（spawn 的 pi -p）禁止再触发提取，斩断递归链
    if (process.env.PI_MEMORY_EXTRACT === '1') return
    const messages = extractTextFromEntries(extractBranch(ctx))
    if (!messages.length) return
    queuePendingExtract(messages, ctx.sessionManager.getSessionId() || null)
  })
}

type BranchCtx = Pick<ExtensionContext, 'sessionManager'>

function extractBranch(ctx: BranchCtx): SessionEntry[] {
  return ctx.sessionManager.getBranch()
}

async function extractFromSession(ctx: BranchCtx): Promise<void> {
  // 提取子进程（spawn 的 pi -p）禁止再触发提取，斩断递归链
  if (process.env.PI_MEMORY_EXTRACT === '1') return
  const sessionId = ctx.sessionManager.getSessionId() || null
  const messages = extractTextFromEntries(extractBranch(ctx))
  if (!messages.length) return
  await extractConversation(messages, { sessionId, messageCount: messages.length })
}
