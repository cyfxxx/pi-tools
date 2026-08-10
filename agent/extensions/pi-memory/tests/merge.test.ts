import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-merge-'))
  process.env.PI_MEMORY_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('merge: decideMerge four actions', () => {
  it('ADD when no similar entries', async () => {
    const { decideMerge } = await import('../merge.ts')
    const decision = await decideMerge([], makeEntry({ title: 'brand new' }))
    expect(decision.action).toBe('ADD')
  })

  it('UPDATE on exact title match', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({ title: 'same title', content: 'aaaa bbbb' })
    const candidate = makeEntry({ title: 'same title', content: 'cccc dddd' })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('UPDATE')
    expect(decision.targetId).toBe(existing.id)
  })

  it('UPDATE on high content similarity (Jaccard > 0.7)', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({ title: 'a', content: 'the quick brown fox jumps over the lazy dog' })
    const candidate = makeEntry({ title: 'b', content: 'the quick brown fox jumps over the lazy cat' })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('UPDATE')
    expect(decision.targetId).toBe(existing.id)
  })

  it('contradiction: 喜欢→不喜欢 supersedes old instead of merging', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({
      title: '咖啡偏好',
      category: 'preference',
      content: '用户喜欢咖啡，每天一杯',
      tags: ['偏好'],
      confidence: 0.9,
    })
    const candidate = makeEntry({
      title: '咖啡偏好更新',
      category: 'preference',
      content: '用户不喜欢咖啡，改喝茶',
      tags: ['偏好'],
      confidence: 0.95,
    })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('ADD')
    expect(existing.supersededBy).toBe(candidate.id)
    expect(existing.deleted).toBe(true)
    expect(decision.note).toContain('矛盾取代')
  })

  it('contradiction: 启用→禁用 supersedes (双向词对)', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({
      title: 'HTTPS 配置',
      category: 'fact',
      content: '服务启用 HTTPS 访问',
      tags: ['服务'],
    })
    const candidate = makeEntry({
      title: 'HTTPS 新配置',
      category: 'fact',
      content: '服务关闭 HTTPS 访问',
      tags: ['服务'],
      confidence: 0.95,
    })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('ADD')
    expect(existing.deleted).toBe(true)
  })

  it('no false positive: 对立词命中但主体不重叠 → 正常 ADD', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({ title: 'x', content: '项目支持 macOS 平台' })
    const candidate = makeEntry({ title: 'y', content: '团队反对加班文化' })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('ADD')
    expect(existing.deleted).toBeFalsy()
  })

  it('detectContradiction 直接单测', async () => {
    const { detectContradiction } = await import('../merge.ts')
    const mk = (c: string) => makeEntry({ content: c })
    expect(detectContradiction(mk('用户喜欢咖啡'), mk('用户不喜欢咖啡'))).toBe(true)
    expect(detectContradiction(mk('服务启用 HTTPS'), mk('服务关闭 HTTPS'))).toBe(true)
    expect(detectContradiction(mk('项目支持 macOS'), mk('团队反对加班'))).toBe(false)
    expect(detectContradiction(mk('今天天气很好'), mk('今天下雨了'))).toBe(false)
  })

  it('conflict resolution: ADD + supersede conflicting manual-source old entry', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({
      title: '旧结论: 部署用 PM2',
      category: 'fact',
      content: '服务器部署方案使用 pm2 进程管理工具',
      tags: ['deploy'],
      confidence: 0.5,
      source: 'extract',
    })
    const candidate = makeEntry({
      title: '新结论: 部署用 Docker',
      category: 'fact',
      content: '服务器部署方案改用 docker compose 容器编排',
      tags: ['deploy'],
      confidence: 0.95,
      source: 'extract',
    })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('ADD')
    expect(existing.supersededBy).toBe(candidate.id)
    expect(existing.deleted).toBe(true)
  })

  it('NOOP when equivalent and candidate not more confident', async () => {
    const { decideMerge } = await import('../merge.ts')
    const existing = makeEntry({ title: 't', content: 'same content here', confidence: 0.9 })
    const candidate = makeEntry({ title: 't2', content: 'same content here', confidence: 0.6 })
    const decision = await decideMerge([existing], candidate)
    expect(decision.action).toBe('NOOP')
  })
})

describe('merge: mergeCandidates', () => {
  it('persists applied candidates to storage', async () => {
    const { loadEntries, saveEntries } = await import('../storage.ts')
    const { mergeCandidates } = await import('../merge.ts')
    saveEntries([])
    const entries = loadEntries()
    const cand = makeEntry({ title: 'persisted' })
    const { applied, skipped } = await mergeCandidates(entries, [cand])
    expect(applied).toEqual(['ADD: persisted'])
    expect(skipped).toEqual([])
    expect(loadEntries()).toHaveLength(1)
  })

  it('skips NOOP candidates', async () => {
    const { loadEntries, saveEntries } = await import('../storage.ts')
    const { mergeCandidates } = await import('../merge.ts')
    saveEntries([makeEntry({ title: 't', content: 'same content here', confidence: 0.95 })])
    const entries = loadEntries()
    const cand = makeEntry({ title: 't2', content: 'same content here', confidence: 0.5 })
    const { applied, skipped } = await mergeCandidates(entries, [cand])
    expect(applied).toEqual([])
    expect(skipped).toEqual(['t2'])
    expect(loadEntries()).toHaveLength(1)
  })
})
