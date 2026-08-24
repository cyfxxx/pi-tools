import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { MemoryEntry } from '../types.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

describe('retrieval: M1 多样性增强', () => {
  it('mmrDiversify banding: 高分锚定条目保持原序（不被多样性挤掉）', async () => {
    const { mmrDiversify, buildDoc } = await import('../retrieval.ts')
    const mk = (id: string, title: string, content: string): MemoryEntry => ({ id, title, content, tags: [], category: 'fact', confidence: 1, source: 'manual', recurrence: 5, createdAt: new Date().toISOString(), updatedAt: '', accessedAt: '' })
    const a = mk('a', 'tmux 配置', 'tmux 键位配置 set -g prefix')
    const b = mk('b', 'tmux 键位', 'tmux 键位配置 set -g prefix 改键 prefix')
    const c = mk('c', 'whisper 服务', 'whisper 127.0.0.1:18766 faster-whisper')
    const docs = new Map([['a', buildDoc(a)], ['b', buildDoc(b)], ['c', buildDoc(c)]])
    const ranked = [
      { e: a, score: 1.0 }, { e: b, score: 0.9 }, { e: c, score: 0.8 },
    ]
    const out = mmrDiversify(ranked, 2, 0.7, docs)
    // banding：b(0.9) 与 top(1.0) 差距 <15% → 锚定保持原序；
    // 即使 b 与 a 主题高度相似也不再被 c 挤掉（缓存前缀稳定）
    expect(out[0].e.id).toBe('a')
    expect(out[1].e.id).toBe('b')
  })

  it('mmrDiversify 尾部 band 内多样性仍生效', async () => {
    const { mmrDiversify, buildDoc } = await import('../retrieval.ts')
    const mk = (id: string, title: string, content: string): MemoryEntry => ({ id, title, content, tags: [], category: 'fact', confidence: 1, source: 'manual', recurrence: 5, createdAt: new Date().toISOString(), updatedAt: '', accessedAt: '' })
    const a = mk('a', 'tmux 配置', 'tmux 键位配置 set -g prefix')
    const b = mk('b', 'tmux 键位', 'tmux 键位配置 set -g prefix 改键 prefix')
    const c = mk('c', 'whisper 服务', 'whisper 127.0.0.1:18766 faster-whisper')
    const d = mk('d', 'whisper GPU', 'whisper 127.0.0.1:18766 faster-whisper cuda')
    const e = mk('e', 'pip 镜像', 'pip 清华镜像源 index-url 安装')
    const docs = new Map([['a', buildDoc(a)], ['b', buildDoc(b)], ['c', buildDoc(c)], ['d', buildDoc(d)], ['e', buildDoc(e)]])
    const ranked = [
      { e: a, score: 1.0 }, { e: b, score: 0.9 }, { e: c, score: 0.8 },
      { e: d, score: 0.79 }, { e: e, score: 0.78 },
    ]
    const out = mmrDiversify(ranked, 4, 0.7, docs)
    // 锚定 [a,b]；pool [c,d,e]：MMR 先取 c（0.8 分最高），再取主题不同的 e
    expect(out.map(x => x.e.id)).toEqual(['a', 'b', 'c', 'e'])
  })

  it('roundRobinBySession interleaves sessions', async () => {
    const { roundRobinBySession } = await import('../retrieval.ts')
    const mk = (id: string, sessionId: string) => ({ e: { id, title: id, content: id, tags: [], category: 'fact' as const, confidence: 1, source: 'manual' as const, recurrence: 1, createdAt: '', updatedAt: '', accessedAt: '', lastSessionId: sessionId }, score: 1 })
    const ranked = [mk('s1a', 'S1'), mk('s1b', 'S1'), mk('s2a', 'S2'), mk('s3a', 'S3')]
    const out = roundRobinBySession(ranked, 4)
    // 轮转：S1→S2→S3→S1
    expect(out.map(x => x.e.lastSessionId)).toEqual(['S1', 'S2', 'S3', 'S1'])
  })
})

describe('retrieval: bi-temporal asOf（2026-08-20，graphiti 时间窗本地化）', () => {
  it('asOf 早于取代时点 → 旧事实可见', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const base = { category: 'preference' as const, content: '用户喜欢咖啡', tags: ['coffee'], confidence: 0.9, source: 'extract' as const }
    const old = makeEntry({ ...base, id: 'old', title: '咖啡偏好', createdAt: '2026-08-01T00:00:00Z', validUntil: '2026-08-10T00:00:00Z', supersededBy: 'new', deleted: true })
    const fresh = makeEntry({ ...base, id: 'fresh', title: '咖啡偏好', createdAt: '2026-08-10T01:00:00Z' })
    const results = searchEntries([old, fresh], undefined, undefined, undefined, 5, undefined, '2026-08-05T00:00:00Z')
    expect(results.map(e => e.id)).toContain('old')
    expect(results.map(e => e.id)).not.toContain('fresh') // 尚未创建
  })

  it('asOf 晚于取代时点 → 旧事实不可见，新条目可见', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const old = makeEntry({ id: 'old', title: '工具偏好', content: '用户启用 X', createdAt: '2026-08-01T00:00:00Z', validUntil: '2026-08-10T00:00:00Z', supersededBy: 'new', deleted: true })
    const fresh = makeEntry({ id: 'fresh', title: '工具偏好', content: '用户禁用 X', createdAt: '2026-08-10T01:00:00Z' })
    const results = searchEntries([old, fresh], '工具', undefined, undefined, 5, undefined, '2026-08-15T00:00:00Z')
    expect(results.map(e => e.id)).not.toContain('old')
    expect(results.map(e => e.id)).toContain('fresh')
  })

  it('软删无 validUntil → 回溯不可见（保守）', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const softDeleted = makeEntry({ id: 'gone', title: '旧条目', deleted: true, createdAt: '2026-08-01T00:00:00Z' })
    const results = searchEntries([softDeleted], undefined, undefined, undefined, 5, undefined, '2026-08-02T00:00:00Z')
    expect(results.map(e => e.id)).not.toContain('gone')
  })

  it('asOf 非法 → 返回空', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const e = makeEntry({ title: '正常条目' })
    const results = searchEntries([e], undefined, undefined, undefined, 5, undefined, 'not-a-date')
    expect(results).toEqual([])
  })

  it('缺省（无 asOf）行为不变：活跃条目 + 排除已取代/软删', async () => {
    const { searchEntries } = await import('../retrieval.ts')
    const live = makeEntry({ title: 'live', content: 'alive' })
    const gone = makeEntry({ title: 'gone', content: 'alive', deleted: true, supersededBy: 'x', validUntil: '2026-08-10T00:00:00Z' })
    const results = searchEntries([live, gone], 'alive', undefined, undefined, 5)
    expect(results.map(e => e.id)).toEqual([live.id])
  })
})

describe('retrieval: qualityScore recency（审计 L2 修复）', () => {
  it('同 createdAt 但 updatedAt 新者分更高', async () => {
    const { qualityScore } = await import('../retrieval.ts')
    const oldTs = '2026-01-01T00:00:00.000Z'
    const freshTs = new Date().toISOString()
    const stale = makeEntry({ id: 'stale', createdAt: oldTs, updatedAt: oldTs, recurrence: 1, confidence: 0.8 })
    const fresh = makeEntry({ id: 'fresh', createdAt: oldTs, updatedAt: freshTs, recurrence: 1, confidence: 0.8 })
    expect(qualityScore(fresh)).toBeGreaterThan(qualityScore(stale))
  })
})
