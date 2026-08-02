import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MemoryEntry } from '../types.ts'

let dir: string
const ORIG_ENV = { ...process.env }

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = new Date().toISOString()
  return {
    id: overrides.id || `id-${Math.random().toString(36).slice(2)}`,
    category: overrides.category || 'fact',
    title: overrides.title || 'test entry',
    content: overrides.content || 'test content for memory entry',
    tags: overrides.tags || ['test'],
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source || 'manual',
    recurrence: overrides.recurrence ?? 1,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    accessedAt: overrides.accessedAt || now,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-ret-'))
  process.env.PI_MEMORY_DIR = dir
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('retrieval: searchEntries', () => {
  it('ranks BM25 lexical match above unrelated entries', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const entries = [
      makeEntry({ title: '用户偏好: 使用 Shell 管理系统', content: '用户习惯用 shell 脚本管理 linux 系统服务', tags: ['shell'], confidence: 0.6 }),
      makeEntry({ title: 'python 依赖安装', content: 'pip install requests 安装 python 包', tags: ['python'], confidence: 0.9 }),
    ]
    const results = searchEntries(entries, 'shell 系统', undefined, undefined, 2)
    expect(results[0].title).toBe('用户偏好: 使用 Shell 管理系统')
  })

  it('ranks by quality when no query given', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const old = new Date(Date.now() - 200 * 86400000).toISOString()
    const entries = [
      makeEntry({ title: 'old low', confidence: 0.4, accessedAt: old, createdAt: old, recurrence: 1 }),
      makeEntry({ title: 'fresh high', confidence: 1.0, recurrence: 5 }),
    ]
    const results = searchEntries(entries, undefined, undefined, undefined, 1)
    expect(results[0].title).toBe('fresh high')
  })

  it('filters by category', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const entries = [
      makeEntry({ title: 'fact one', category: 'fact' }),
      makeEntry({ title: 'pref one', category: 'preference' }),
    ]
    const results = searchEntries(entries, undefined, 'preference', undefined, 5)
    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('preference')
  })

  it('filters by tags', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const entries = [
      makeEntry({ title: 'tagged', tags: ['linux', 'ops'] }),
      makeEntry({ title: 'untagged', tags: ['other'] }),
    ]
    const results = searchEntries(entries, undefined, undefined, ['linux'], 5)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('tagged')
  })

  it('supports Chinese bigram query match', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const entries = [
      makeEntry({ title: '数据库备份流程', content: '每日凌晨备份 mysql 数据库到远程服务器', tags: ['backup'] }),
      makeEntry({ title: '前端构建', content: 'vite build 打包前端', tags: ['frontend'] }),
    ]
    const results = searchEntries(entries, '备份', undefined, undefined, 2)
    expect(results[0].title).toBe('数据库备份流程')
  })

  it('excludes deleted and superseded entries', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const entries = [
      makeEntry({ title: 'alive', deleted: false }),
      makeEntry({ title: 'deleted', deleted: true }),
      makeEntry({ title: 'superseded', supersededBy: 'x' }),
    ]
    const results = searchEntries(entries, 'alive', undefined, undefined, 5)
    expect(results.map(r => r.title)).toEqual(['alive'])
  })
})

describe('retrieval: helpers', () => {
  it('bm25Score gives higher score for title field', async () => {
    const { bm25Score } = await import('../retrieval.ts')
    const df = new Map([['foo', 1]])
    const titleDoc = { title: ['foo'], tags: [], content: [], all: new Set(['foo']) }
    const contentDoc = { title: [], tags: [], content: ['foo'], all: new Set(['foo']) }
    const n = 2
    const avgLen = 2
    const titleScore = bm25Score(['foo'], titleDoc, df, n, avgLen)
    const contentScore = bm25Score(['foo'], contentDoc, df, n, avgLen)
    expect(titleScore).toBeGreaterThan(contentScore)
  })

  it('qualityScore rewards recency and recurrence', async () => {
    const { qualityScore } = await import('../retrieval.ts')
    const old = new Date(Date.now() - 200 * 86400000).toISOString()
    const stale = makeEntry({ createdAt: old, accessedAt: old, recurrence: 1 })
    const fresh = makeEntry({ recurrence: 8 })
    expect(qualityScore(fresh)).toBeGreaterThan(qualityScore(stale))
  })
})
