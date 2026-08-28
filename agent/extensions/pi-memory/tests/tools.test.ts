import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dir: string
const ORIG_ENV = { ...process.env }

interface RegisteredTool {
  name: string
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; isError?: boolean }>
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    category: 'fact',
    title: 'test entry',
    content: 'content for tools test',
    tags: ['t'],
    confidence: 0.8,
    source: 'manual',
    recurrence: 1,
    createdAt: overrides.createdAt || now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  }
}

async function loadForgetTool(): Promise<RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {}
  const piMock = { registerTool: (t: RegisteredTool) => { tools[t.name] = t } }
  const { registerTools } = await import('../tools.ts')
  registerTools(piMock as never)
  return tools['memory_forget']
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-tools-'))
  process.env.PI_MEMORY_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('tools: memory_forget 批量删除', () => {
  it('category+olderThan 删除后落盘（磁盘重新加载不复活）', async () => {
    const old = new Date('2024-01-01T00:00:00Z').toISOString()
    const fresh = new Date('2026-06-01T00:00:00Z').toISOString()
    const entries = [
      makeEntry({ id: 'a', category: 'fact', createdAt: old }),
      makeEntry({ id: 'b', category: 'fact', createdAt: fresh }),
      makeEntry({ id: 'c', category: 'preference', createdAt: old }),
    ]
    writeFileSync(join(dir, 'entries.json'), JSON.stringify({ version: 1, entries }), 'utf-8')

    const forget = await loadForgetTool()
    const res = await forget.execute('call-1', { category: 'fact', olderThan: '2025-01-01' })
    const text = res.content[0].text
    expect(text).toContain('已删除 1 条')

    // 关键断言：磁盘文件已更新（修复前只改内存数组，此处仍为 3 条）
    const saved = JSON.parse(readFileSync(join(dir, 'entries.json'), 'utf-8'))
    expect(saved.entries).toHaveLength(2)
    expect(saved.entries.map((e: { id: string }) => e.id).sort()).toEqual(['b', 'c'])
  })

  it('批量删除不影响其他类别', async () => {
    const old = new Date('2024-01-01T00:00:00Z').toISOString()
    writeFileSync(join(dir, 'entries.json'), JSON.stringify({
      version: 1,
      entries: [
        makeEntry({ id: 'a', category: 'fact', createdAt: old }),
        makeEntry({ id: 'b', category: 'preference', createdAt: old }),
      ],
    }), 'utf-8')

    const forget = await loadForgetTool()
    const res = await forget.execute('call-1', { category: 'fact', olderThan: '2025-01-01' })
    expect(res.content[0].text).toContain('已删除 1 条')

    const saved = JSON.parse(readFileSync(join(dir, 'entries.json'), 'utf-8'))
    expect(saved.entries.map((e: { id: string }) => e.id)).toEqual(['b'])
  })

  it('单条 id 删除路径仍正常（软删墓碑：条目保留、deleted=true，审计修复对齐 Mem0 DELETE）', async () => {
    writeFileSync(join(dir, 'entries.json'), JSON.stringify({
      version: 1,
      entries: [makeEntry({ id: 'only' })],
    }), 'utf-8')

    const forget = await loadForgetTool()
    const res = await forget.execute('call-1', { id: 'only' })
    expect(res.content[0].text).toContain('已删除记忆 only')
    const saved = JSON.parse(readFileSync(join(dir, 'entries.json'), 'utf-8'))
    // 软删墓碑：条目不从磁盘移除，标记 deleted=true（检索/统计路径过滤）
    expect(saved.entries).toHaveLength(1)
    expect(saved.entries[0].id).toBe('only')
    expect(saved.entries[0].deleted).toBe(true)
  })

  it('无效日期返回 isError', async () => {
    writeFileSync(join(dir, 'entries.json'), JSON.stringify({ version: 1, entries: [makeEntry()] }), 'utf-8')
    const forget = await loadForgetTool()
    const res = await forget.execute('call-1', { category: 'fact', olderThan: 'not-a-date' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('无效日期')
  })
})
