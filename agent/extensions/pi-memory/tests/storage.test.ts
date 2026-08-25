import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MemoryEntry, SummaryEntry } from '../types.ts'

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
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-test-'))
  process.env.PI_MEMORY_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('storage: entries', () => {
  it('loadEntries returns [] for missing file', async () => {
    const { loadEntries } = await import('../storage.ts')
    expect(loadEntries()).toEqual([])
  })

  it('saveEntries + loadEntries roundtrip', async () => {
    const { loadEntries, saveEntries } = await import('../storage.ts')
    const e = makeEntry()
    saveEntries([e])
    const loaded = loadEntries()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].title).toBe(e.title)
    expect(loaded[0].observedAt).toBeTruthy()
  })

  it('migrates v1 entries (no observedAt/id/deleted) to v2', async () => {
    const file = join(dir, 'entries.json')
    const v1: Record<string, unknown>[] = [
      {
        category: 'fact',
        title: 'old entry',
        content: 'legacy content',
        tags: [],
        confidence: 0.9,
        source: 'manual',
        recurrence: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        accessedAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    writeFileSync(file, JSON.stringify({ version: 1, entries: v1 }))
    const { loadEntries } = await import('../storage.ts')
    const loaded = loadEntries()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBeTruthy()
    expect(loaded[0].observedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(loaded[0].deleted).toBe(false)
  })

  it('writes atomically (tmp + rename)', async () => {
    const { saveEntries, loadEntries } = await import('../storage.ts')
    saveEntries([makeEntry()])
    expect(existsSync(join(dir, 'entries.json.tmp'))).toBe(false)
    expect(loadEntries()).toHaveLength(1)
  })

  it('saveEntries merges concurrent additions from disk (审计 MEDIUM：并发不丢更新)', async () => {
    const { saveEntries, loadEntries } = await import('../storage.ts')
    // 模拟：磁盘已有条目 A（提取子进程写回前主进程新增）
    const diskEntry = makeEntry({ title: 'disk-added' })
    saveEntries([diskEntry])
    // 模拟：快照不含 A 的写回（旧快照），仅含 B
    const b = makeEntry({ title: 'snapshot-b' })
    saveEntries([b])
    const loaded = loadEntries()
    const ids = loaded.map(e => e.title)
    // 并发新增 A 不被覆盖丢失；B 正常写入
    expect(ids).toContain('disk-added')
    expect(ids).toContain('snapshot-b')
    // 传入快照优先：同 id 以调用方为准
    const c = makeEntry({ title: 'overwrite-me' })
    saveEntries([c])
    saveEntries([{ ...c, title: 'overwritten' }])
    const after = loadEntries()
    expect(after.find(e => e.id === c.id)?.title).toBe('overwritten')
  })

  it('saveEntries does not resurrect deleted entries (回收语义保留)', async () => {
    const { saveEntries, loadEntries } = await import('../storage.ts')
    const e = makeEntry({ title: 'to-recycle' })
    saveEntries([e])
    // 软删除后回收（filter 移除）→ saveEntries 写回不得把 deleted 条目合并回来
    saveEntries([{ ...e, deleted: true }])
    saveEntries([])
    expect(loadEntries()).toHaveLength(0)
  })
})

describe('storage: notes + ctx-lite migration', () => {
  it('preserves _ctx.* internal keys and applies TTL expiry', async () => {
    const { loadNotes } = await import('../storage.ts')
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({
      '_ctx.compacted_at': '2026-01-01T00:00:00.000Z',
      'task.status': 'running',
      'expired.key': 'gone',
      '__ttl_expired.key': '2020-01-01T00:00:00.000Z',
    }))
    const notes = loadNotes()
    expect(notes['_ctx.compacted_at']).toBe('2026-01-01T00:00:00.000Z')
    expect(notes['task.status']).toBe('running')
    expect(notes['expired.key']).toBeUndefined()
    expect(notes['__ttl_expired.key']).toBeUndefined()
  })

  it('migrates data from old ~/.pi/ctx-lite dir', async () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'pi-ctxlite-src-'))
    process.env.CTX_LITE_DIR = oldDir
    mkdirSync(join(oldDir, 'checkpoints'), { recursive: true })
    writeFileSync(join(oldDir, 'notes.json'), JSON.stringify({ 'legacy.note': 'value' }))
    writeFileSync(join(oldDir, 'checkpoints', 'cp1.json'), JSON.stringify({ ok: true }))

    const { loadNotes, CHECKPOINTS_DIR } = await import('../storage.ts')
    const notes = loadNotes()
    expect(notes['legacy.note']).toBe('value')
    expect(existsSync(join(CHECKPOINTS_DIR, 'cp1.json'))).toBe(true)

    rmSync(oldDir, { recursive: true, force: true })
  })
})

describe('storage: summaries', () => {
  it('appendSummary upserts same sessionId (重复摘要根因回归)', async () => {
    const { appendSummary, loadSummaries } = await import('../storage.ts')
    const base = { decisions: [], facts: [], prefs: [], lessons: [] }
    appendSummary({ id: 'a1', sessionId: 'dup-sess', ts: '2026-01-01T00:00:00Z', title: '旧摘要', fullText: 'old', ...base })
    appendSummary({ id: 'a2', sessionId: 'dup-sess', ts: '2026-01-02T00:00:00Z', title: '新摘要', fullText: 'new', ...base })
    const all = loadSummaries()
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('新摘要')
    expect(all[0].fullText).toBe('new')
    // 无 sessionId 的仍追加
    appendSummary({ id: 'a3', sessionId: null, ts: '2026-01-03T00:00:00Z', title: '无会话', fullText: '', ...base })
    expect(loadSummaries()).toHaveLength(2)
  })

  it('appendSummary trims to 50 entries', async () => {
    const { appendSummary, loadSummaries } = await import('../storage.ts')
    for (let i = 0; i < 55; i++) {
      appendSummary({
        id: `s${i}`,
        sessionId: null,
        ts: new Date().toISOString(),
        title: `summary ${i}`,
        decisions: [],
        facts: [],
        prefs: [],
        lessons: [],
        fullText: '',
      })
    }
    const all = loadSummaries()
    expect(all).toHaveLength(50)
    expect(all[0].title).toBe('summary 5')
  })
})

describe('storage: applyMem0Action four operations', () => {
  it('ADD appends candidate', async () => {
    const { loadEntries, applyMem0Action } = await import('../storage.ts')
    const entries = loadEntries()
    const cand = makeEntry()
    const { applied } = applyMem0Action(entries, 'ADD', cand)
    expect(applied).toBe(true)
    expect(entries).toHaveLength(1)
  })

  it('UPDATE merges into target', async () => {
    const { loadEntries, saveEntries, applyMem0Action } = await import('../storage.ts')
    const existing = makeEntry({ title: 'target', content: 'old', recurrence: 1, environments: ['termux'] })
    saveEntries([existing])
    const entries = loadEntries()
    const cand = makeEntry({ title: 'target', content: 'newer details', environments: ['linux'] })
    const { applied } = applyMem0Action(entries, 'UPDATE', cand, existing.id)
    expect(applied).toBe(true)
    expect(entries[0].content).toBe('newer details')
    expect(entries[0].recurrence).toBe(2)
    expect(entries[0].tags).toContain('test')
    expect(entries[0].environments).toEqual(expect.arrayContaining(['termux', 'linux']))
  })

  it('DELETE soft-deletes target', async () => {
    const { loadEntries, saveEntries, applyMem0Action, activeEntries } = await import('../storage.ts')
    const existing = makeEntry({ title: 'victim' })
    saveEntries([existing])
    const entries = loadEntries()
    const { applied } = applyMem0Action(entries, 'DELETE', makeEntry(), existing.id)
    expect(applied).toBe(true)
    expect(entries[0].deleted).toBe(true)
    expect(activeEntries(entries)).toHaveLength(0)
  })

  it('NOOP does nothing', async () => {
    const { loadEntries, applyMem0Action } = await import('../storage.ts')
    const entries = loadEntries()
    const { applied } = applyMem0Action(entries, 'NOOP', makeEntry())
    expect(applied).toBe(false)
    expect(entries).toHaveLength(0)
  })
})

describe('storage: prune + stats', () => {
  it('pruneEntries removes low-confidence cold entries', async () => {
    const { loadEntries, saveEntries, pruneEntries } = await import('../storage.ts')
    const old = new Date(Date.now() - 40 * 86400000).toISOString()
    const e1 = makeEntry({ title: 'cold low conf', confidence: 0.2, accessedAt: old })
    const e2 = makeEntry({ title: 'warm', confidence: 0.9 })
    saveEntries([e1, e2])
    const entries = loadEntries()
    const result = pruneEntries(entries)
    expect(result.removed).toBe(1)
    expect(result.titles).toEqual(['cold low conf'])
    expect(entries.map(e => e.title)).toEqual(['warm'])
  })

  it('pruneEntries 剪枝后落盘不复活（审计实测：saveEntries 写前合并会补回磁盘活跃条目）', async () => {
    const { loadEntries, saveEntries, pruneEntries } = await import('../storage.ts')
    const old = new Date(Date.now() - 40 * 86400000).toISOString()
    const e1 = makeEntry({ title: 'cold low conf', confidence: 0.2, accessedAt: old })
    const e2 = makeEntry({ title: 'warm', confidence: 0.9 })
    saveEntries([e1, e2])
    const entries = loadEntries()
    const result = pruneEntries(entries)
    expect(result.removed).toBe(1)
    // 重新从磁盘加载：被剪枝的条目不得被写前合并复活
    const reloaded = loadEntries()
    expect(reloaded.map(e => e.title)).toEqual(['warm'])
    expect(reloaded).toHaveLength(1)
  })

  it('autoReclaim 超阈值时回收 deleted 条目且落盘', async () => {
    const { loadEntries, saveEntries, autoReclaim } = await import('../storage.ts')
    const many = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ title: `n${i}`, deleted: i >= 5 }),
    )
    saveEntries(many)
    const result = autoReclaim(loadEntries(), 5)
    expect(result).not.toBeNull()
    expect(result!.map(e => e.title)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
    // 已落盘：再次加载仍为回收后状态
    expect(loadEntries().map(e => e.title)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4'])
  })

  it('autoReclaim 未超阈值或无 deleted 条目时不触发', async () => {
    const { loadEntries, saveEntries, autoReclaim } = await import('../storage.ts')
    const few = Array.from({ length: 3 }, (_, i) => makeEntry({ title: `n${i}` }))
    saveEntries(few)
    expect(autoReclaim(loadEntries(), 5)).toBeNull()
    const allDeleted = Array.from({ length: 6 }, (_, i) =>
      makeEntry({ title: `d${i}`, deleted: false }),
    )
    saveEntries(allDeleted)
    expect(autoReclaim(loadEntries(), 5)).toBeNull()
  })

  it('getStats counts active/superseded/summaries', async () => {
    const { loadEntries, saveEntries, getStats } = await import('../storage.ts')
    const now = new Date().toISOString()
    saveEntries([
      makeEntry({ title: 'a', category: 'fact' }),
      makeEntry({ title: 'b', category: 'preference', deleted: true }),
      makeEntry({ title: 'c', category: 'habit', supersededBy: 'x' }),
    ])
    const stats = getStats(loadEntries())
    expect(stats.totalEntries).toBe(3)
    expect(stats.activeEntries).toBe(1)
    expect(stats.superseded).toBe(1)
    expect(stats.byCategory.fact).toBe(1)
  })
})

describe('storage: tokenize', () => {
  it('splits mixed content and adds Chinese bigrams', async () => {
    const { tokenize } = await import('../storage.ts')
    const t = tokenize('hello world 项目管理')
    expect(t).toContain('hello')
    expect(t).toContain('world')
    expect(t).toContain('项目')
    expect(t).toContain('管理')
  })

  it('jaccardSimilarity: identical=1, disjoint=0', async () => {
    const { jaccardSimilarity, tokenize } = await import('../storage.ts')
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1)
    expect(jaccardSimilarity(['a'], ['b'])).toBe(0)
    expect(jaccardSimilarity([], [])).toBe(0)
  })
})

describe('storage: secret scrubbing', () => {
  it('scrubSecrets redacts github token / api key / jwt / bearer / aws', async () => {
    const { scrubSecrets } = await import('../storage.ts')
    const out = scrubSecrets(
      'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 key=sk-abc12345def67890ghi ' +
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y ' +
      'bearer=Bearer abcdefghijklmnopqrstuvwxyz012345 aws=AKIAIOSFODNN7EXAMPLE'
    )
    expect(out).toContain('[REDACTED:github-token]')
    expect(out).toContain('[REDACTED:api-key]')
    expect(out).toContain('[REDACTED:jwt]')
    expect(out).toContain('[REDACTED:bearer-token]')
    expect(out).toContain('[REDACTED:aws-key]')
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]{20,}/)
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{15,}/)
  })

  it('does not false-positive on normal text and UUIDs', async () => {
    const { scrubSecrets } = await import('../storage.ts')
    const uuid = 'e0a1406c-1a6d-49b0-85ef-94804123f067'
    const normal = 'sk-1 短后缀、AKIA 无长尾、Bearer 后短词、eyJ 单段不匹配'
    expect(scrubSecrets(uuid)).toBe(uuid)
    expect(scrubSecrets(normal)).toBe(normal)
  })

  it('saveEntries scrubs persisted entry fields', async () => {
    const { saveEntries, loadEntries } = await import('../storage.ts')
    saveEntries([makeEntry({
      title: 'PAT 泄露核实',
      content: 'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 仍有效',
      tags: ['ghp_ABC123def456ghi789jkl012mno345p', '正常tag'],
    })])
    const loaded = loadEntries()
    expect(loaded[0].content).toContain('[REDACTED:github-token]')
    expect(loaded[0].content).not.toContain('ghp_ABCDEF')
    expect(loaded[0].tags[0]).toBe('[REDACTED:github-token]')
    expect(loaded[0].tags[1]).toBe('正常tag')
  })

  it('appendSummary scrubs summary fields', async () => {
    const { appendSummary, loadSummaries } = await import('../storage.ts')
    appendSummary({
      id: 's1',
      sessionId: 'ses1',
      ts: new Date().toISOString(),
      title: '会话含密钥',
      decisions: ['使用 sk-proj-abcdefghijklmnopqrstuvwxyz123456 接入'],
      facts: [],
      prefs: [],
      lessons: [],
      fullText: 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.abc.def 已轮换，裸 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y 也脱敏',
    })
    const loaded = loadSummaries()
    expect(loaded[0].decisions[0]).toContain('[REDACTED:api-key]')
    // Bearer 前缀的 JWT 由 bearer 规则整体替换
    expect(loaded[0].fullText).toContain('[REDACTED:bearer-token]')
    // 裸 JWT（无 Bearer 前缀）由 jwt 规则替换
    expect(loaded[0].fullText).toContain('[REDACTED:jwt]')
    expect(loaded[0].fullText).not.toContain('eyJ0eXAi')
    expect(loaded[0].fullText).not.toContain('SflKxwRJ')
  })

  it('saveNotes scrubs values but keeps __ttl_ keys intact', async () => {
    const { saveNotes, loadNotes } = await import('../storage.ts')
    saveNotes({
      'task.status': '使用 sk-abcdefghijklmnopqrstuvwxy 连接',
      '__ttl_task.status': '2026-12-31T23:59:59Z',
    })
    const loaded = loadNotes()
    expect(loaded['task.status']).toContain('[REDACTED:api-key]')
    expect(loaded['__ttl_task.status']).toBe('2026-12-31T23:59:59Z')
  })

  it('scrub is idempotent (already-redacted text unchanged)', async () => {
    const { scrubSecrets } = await import('../storage.ts')
    const once = scrubSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(scrubSecrets(once)).toBe(once)
  })
})

describe('storage: corruption 防护与并发合并（审计 HIGH/MEDIUM 修复）', () => {
  it('loadEntries 遇损坏 JSON：备份 .corrupt-* 且返回 []（不静默覆盖清空）', async () => {
    const { loadEntries } = await import('../storage.ts')
    const file = join(dir, 'entries.json')
    writeFileSync(file, 'garbage {{{ not json <<<<<<< HEAD conflict')
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = loadEntries()
    logSpy.mockRestore()
    expect(loaded).toEqual([])
    expect(existsSync(file)).toBe(false) // 损坏原文件已改名备份，不被后续覆盖
    const backups = readdirSync(dir).filter((f) => f.startsWith('entries.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]), 'utf-8')).toContain('<<<<<<<')
  })

  it('loadSummaries 遇损坏 JSON：同款备份防护（2026-08-25 HIGH 对齐）', async () => {
    const { loadSummaries, saveSummaries } = await import('../storage.ts')
    const file = join(dir, 'summaries.json')
    writeFileSync(file, '{broken summaries <<< HEAD')
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = loadSummaries()
    logSpy.mockRestore()
    expect(loaded).toEqual([])
    expect(existsSync(file)).toBe(false)
    const backups = readdirSync(dir).filter((f) => f.startsWith('summaries.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]), 'utf-8')).toContain('<<< HEAD')
    // 后续保存不清掉备份：原始数据仍可人工恢复
    saveSummaries([])
    expect(existsSync(join(dir, backups[0]))).toBe(true)
  })

  it('loadNotes 遇损坏 JSON：同款备份防护（2026-08-25 HIGH 对齐）', async () => {
    const { loadNotes } = await import('../storage.ts')
    const file = join(dir, 'notes.json')
    writeFileSync(file, 'not json at all {{{')
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = loadNotes()
    logSpy.mockRestore()
    expect(loaded).toEqual({})
    expect(existsSync(file)).toBe(false)
    const backups = readdirSync(dir).filter((f) => f.startsWith('notes.json.corrupt-'))
    expect(backups).toHaveLength(1)
  })

  it('saveEntries 返回合并后数组，吸收磁盘并发新增（L5）', async () => {
    const { saveEntries } = await import('../storage.ts')
    const a = makeEntry({ id: 'a1', title: 'A' })
    const b = makeEntry({ id: 'b1', title: 'B' })
    saveEntries([a, b])
    // 调用方内存只剩 a（旧快照），磁盘另有 b；saveEntries 应返回合并两者
    const merged = saveEntries([a])
    expect(merged.map((e) => e.id).sort()).toEqual(['a1', 'b1'])
  })
})

describe('lib/note-store 与 pi-memory 对齐（2026-08-25 审计修复）', () => {
  it('saveNotes 经 scrubSecrets 净化（封堵脱敏旁路）', async () => {
    const { saveNotes, loadNotes } = await import('../../../lib/note-store.ts')
    saveNotes({ 'ctx.key': 'token sk-abcdefghijklmnopqrstuvwxy in note' })
    const loaded = loadNotes()
    expect(loaded['ctx.key']).toContain('[REDACTED:api-key]')
    // 落盘文件本身同样净化
    const raw = readFileSync(join(dir, 'notes.json'), 'utf-8')
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxy')
  })

  it('loadNotes 遇损坏 JSON：备份 .corrupt-* 且不静默清空（HIGH 对齐）', async () => {
    const { loadNotes } = await import('../../../lib/note-store.ts')
    const file = join(dir, 'notes.json')
    writeFileSync(file, 'garbage {{{ broken')
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const loaded = loadNotes()
    logSpy.mockRestore()
    expect(loaded).toEqual({})
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.startsWith('notes.json.corrupt-'))).toHaveLength(1)
  })
})
