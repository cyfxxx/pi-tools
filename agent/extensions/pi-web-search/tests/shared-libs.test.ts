import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// ─── token-budget shared lib ────────────────────────────────
describe('shared lib: token-budget', () => {
  beforeEach(async () => {
    const mod = await import('../../../lib/token-budget')
    mod.resetBudget()
  })

  it('multiple extensions can record tool usage', async () => {
    const mod = await import('../../../lib/token-budget')
    mod.recordToolUsage('web_search', 100)
    mod.recordToolUsage('ctx_exec', 200)
    mod.recordToolUsage('web_fetch', 50)
    const report = mod.getBudgetReport()
    expect(report.total).toBeGreaterThanOrEqual(350)
  })

  it('getTokenPressureTag returns null under threshold', async () => {
    const mod = await import('../../../lib/token-budget')
    mod.resetBudget()
    mod.recordToolUsage('test', 100)
    expect(mod.getTokenPressureTag()).toBeNull()
  })

  it('estimateTokens works for various inputs', async () => {
    const mod = await import('../../../lib/token-budget')
    expect(mod.estimateTokens('hello world')).toBeGreaterThan(0)
    expect(mod.estimateTokens('')).toBe(0)
    expect(mod.estimateTokens('a'.repeat(1000))).toBeGreaterThan(100)
  })

  it('truncateByTokens preserves prefix and shortens', async () => {
    const mod = await import('../../../lib/token-budget')
    const text = 'hello world foo bar baz ' + 'x'.repeat(1000)
    const truncated = mod.truncateByTokens(text, 10)
    expect(truncated.length).toBeLessThan(text.length)
    expect(truncated.startsWith('hello')).toBe(true)
  })
})

// ─── prune shared lib ───────────────────────────────────────
describe('shared lib: prune', () => {
  beforeEach(async () => {
    const mod = await import('../../../lib/prune')
    mod.resetOutputBudget()
  })

  it('recordOutput and pruneToolOutput work', async () => {
    const mod = await import('../../../lib/prune')
    const output = 'x'.repeat(1000)
    const pruned = mod.pruneToolOutput(output, 'test_tool')
    expect(pruned).toBe(output)
    mod.recordOutput('test_tool', 1000)
    // second call should still work (under budget)
    const pruned2 = mod.pruneToolOutput(output, 'test_tool')
    expect(pruned2).toBe(output)
  })

  it('pruneToolOutput truncates when over budget', async () => {
    const mod = await import('../../../lib/prune')
    // Exhaust token budget first (20K tokens ≈ 70K chars at 3.5 chars/token)
    mod.recordOutput('big_tool', 70000)

    // Now add more - should trigger truncation
    const more = 'y'.repeat(5000)
    const result = mod.pruneToolOutput(more, 'another_tool')
    expect(result).toContain('输出已截断')
    expect(result.length).toBeLessThan(5000)
  })
})

// ─── note-store shared lib (ctx-lite ↔ plan-mode) ──────────
describe('shared lib: note-store (ctx-lite ↔ plan-mode)', () => {
  const testDir = join(tmpdir(), `pi-test-notes-${randomUUID()}`)

  beforeEach(() => {
    process.env.CTX_LITE_DIR = testDir
  })

  afterEach(() => {
    delete process.env.CTX_LITE_DIR
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('notes written by ctx-lite can be read by plan-mode via same file', async () => {
    const store = await import('../../../lib/note-store')
    // Simulate ctx-lite storing a note
    const notes = { 'task:current': 'implement feature X' }
    store.saveNotes(notes)

    // Simulate plan-mode reading the same notes
    const loaded = store.loadNotes()
    expect(loaded['task:current']).toBe('implement feature X')
  })

  it('ctx-lite writes compaction flag, plan-mode reads it', async () => {
    const store = await import('../../../lib/note-store')
    // ctx-lite sets compaction flags
    const notes = {
      '_ctx.just_compacted': 'true',
      '_ctx.compacted_at': new Date().toISOString(),
    }
    store.saveNotes(notes)

    // plan-mode loads and sees the flag
    const loaded = store.loadNotes()
    expect(loaded['_ctx.just_compacted']).toBe('true')
    expect(loaded['_ctx.compacted_at']).toBeDefined()

    // plan-mode clears the flag
    store.clearCompactionFlag()
    const after = store.loadNotes()
    expect(after['_ctx.just_compacted']).toBeUndefined()
  })

  it('TTL notes expire correctly', async () => {
    const store = await import('../../../lib/note-store')
    const expired = new Date(Date.now() - 1000).toISOString()
    const active = new Date(Date.now() + 86400000).toISOString()
    const notes = {
      'expired:note': 'should be gone',
      '__ttl_expired:note': expired,
      'active:note': 'should remain',
      '__ttl_active:note': active,
    }
    store.saveNotes(notes)

    const loaded = store.loadNotes()
    expect(loaded['expired:note']).toBeUndefined()
    expect(loaded['active:note']).toBe('should remain')
  })

  it('getTotalSize excludes metadata keys', async () => {
    const store = await import('../../../lib/note-store')
    const notes = {
      'data:key': 'hello world',
      '__ttl_data:key': 'some-date',
      '_ctx.just_compacted': 'true',
    }
    const size = store.getTotalSize(notes)
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(Buffer.byteLength('hello world') * 3)
  })
})
