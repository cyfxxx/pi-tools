import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
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
    const existing = makeEntry({ title: 'target', content: 'old', recurrence: 1 })
    saveEntries([existing])
    const entries = loadEntries()
    const cand = makeEntry({ title: 'target', content: 'newer details' })
    const { applied } = applyMem0Action(entries, 'UPDATE', cand, existing.id)
    expect(applied).toBe(true)
    expect(entries[0].content).toBe('newer details')
    expect(entries[0].recurrence).toBe(2)
    expect(entries[0].tags).toContain('test')
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
    const removed = pruneEntries(entries)
    expect(removed).toBe(1)
    expect(entries.map(e => e.title)).toEqual(['warm'])
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
