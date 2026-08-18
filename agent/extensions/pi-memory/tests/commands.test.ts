import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SummaryEntry } from '../types.ts'

let dir: string
const ORIG_ENV = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-cmd-'))
  process.env.PI_MEMORY_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** 注册 /memory 并取回 handler（模仿 index-compact.test.ts 的 fake pi 模式） */
async function loadMemoryHandler(): Promise<(args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>> {
  vi.resetModules()
  const { registerCommands } = await import('../commands.ts')
  let handler: ((args: string, ctx: unknown) => unknown) | undefined
  const pi = {
    registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => unknown }) => {
      handler = def.handler
    },
  } as never
  registerCommands(pi as never)
  return handler as (args: string, ctx: { ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>
}

function mkSummary(ts: string, title: string): SummaryEntry {
  return { id: `s-${title}`, sessionId: null, ts, title, decisions: [], facts: [], prefs: [], lessons: [], fullText: title }
}

describe('commands: /memory summary 按 ts 倒序', () => {
  it('插入序与 ts 序不一致时取最近 N 条（修复前 slice(-limit) 取到非最近摘要）', async () => {
    const handler = await loadMemoryHandler()
    const { saveSummaries } = await import('../storage.ts')
    // 模拟 pending 延迟提取乱序 append：旧摘要后插入
    saveSummaries([
      mkSummary('2026-01-01T00:00:00Z', '旧会话A'),
      mkSummary('2026-03-01T00:00:00Z', '最新会话B'),
      mkSummary('2026-02-01T00:00:00Z', '中间会话C'),
    ])
    const notify = vi.fn()
    await handler('summary', { ui: { notify } })
    expect(notify).toHaveBeenCalledTimes(1)
    const text = String(notify.mock.calls[0][0])
    // 首行是标题头，第二行起为摘要条目：第一条（最新）必须是 ts 最大者，而非插入序最后一条
    expect(text.split('\n')[1]).toContain('2026-03-01')
    expect(text.split('\n')[1]).toContain('最新会话B')
    // 全量按 ts 倒序展示
    const titles = text.match(/「(.+?)」/g) ?? []
    expect(titles).toEqual(['「最新会话B」', '「中间会话C」', '「旧会话A」'])
  })

  it('limit 参数生效：ts 倒序后取前 N 条', async () => {
    const handler = await loadMemoryHandler()
    const { saveSummaries } = await import('../storage.ts')
    saveSummaries([
      mkSummary('2026-01-01T00:00:00Z', 'A'),
      mkSummary('2026-02-01T00:00:00Z', 'B'),
      mkSummary('2026-03-01T00:00:00Z', 'C'),
    ])
    const notify = vi.fn()
    await handler('summary 2', { ui: { notify } })
    const text = String(notify.mock.calls[0][0])
    const titles = text.match(/「(.+?)」/g) ?? []
    expect(titles).toEqual(['「C」', '「B」'])
  })
})
