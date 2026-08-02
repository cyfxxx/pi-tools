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
import { extractConversation, extractTextFromEntries } from './extract.ts'
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

  // ── 会话结束: 提取 ──
  pi.on('session_shutdown', async (_event, ctx) => {
    await extractFromSession(ctx)
  })
}

async function extractFromSession(ctx: { sessionManager: { getSessionId(): string | null; getBranch(): Array<{ type: string; role?: string; content?: unknown; message?: { role?: string; content?: unknown } }> } }): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId() || null
  const branch = ctx.sessionManager.getBranch()
  const messages = extractTextFromEntries(branch as Array<{ role?: string; content?: unknown; message?: { role?: string; content?: unknown } }>)
  if (!messages.length) return
  await extractConversation(messages, { sessionId, messageCount: messages.length })
}
