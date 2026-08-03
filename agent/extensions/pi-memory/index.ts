import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  loadEntries,
  loadNotes,
  loadSummaries,
  saveNotes,
  activeEntries,
  migrateFromCtxLite,
} from './storage.ts'
import { registerTools } from './tools.ts'
import { registerCommands } from './commands.ts'
import { buildInjectionBlock } from './inject.ts'
import { extractConversation, extractTextFromEntries, processPendingExtracts, queuePendingExtract } from './extract.ts'
import { writeCompactionSnapshot } from './snapshot.ts'

export default function (pi: ExtensionAPI): void {
  registerTools(pi)
  registerCommands(pi)

  // ── 启动迁移报告 + compaction 恢复检测 ──
  pi.on('session_start', async (_event, ctx) => {
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
    void processPendingExtracts().then(({ ok, failed }) => {
      if (ok > 0 && ctx.hasUI) {
        ctx.ui.notify(`pi-memory: 已补提取 ${ok} 个待处理会话${failed > 0 ? `（${failed} 个失败保留）` : ''}`, 'info')
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
  pi.on('before_agent_start', async (event, _ctx) => {
    const entries = loadEntries()
    const summaries = loadSummaries()
    const { block, entries: n, summaries: m } = buildInjectionBlock(entries, summaries)
    if (n === 0 && m === 0) return undefined
    return {
      systemPrompt: event.systemPrompt + '\n\n' + block,
    }
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

function extractBranch(ctx: { sessionManager: { getSessionId(): string | null; getBranch(): Array<{ type: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } }> } }): Array<{ type: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } }> {
  return ctx.sessionManager.getBranch()
}

async function extractFromSession(ctx: { sessionManager: { getSessionId(): string | null; getBranch(): Array<{ type: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } }> } }): Promise<void> {
  // 提取子进程（spawn 的 pi -p）禁止再触发提取，斩断递归链
  if (process.env.PI_MEMORY_EXTRACT === '1') return
  const sessionId = ctx.sessionManager.getSessionId() || null
  const messages = extractTextFromEntries(extractBranch(ctx))
  if (!messages.length) return
  await extractConversation(messages, { sessionId, messageCount: messages.length })
}
