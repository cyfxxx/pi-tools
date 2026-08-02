import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  MemoryEntry,
  MemoryStore,
  MemoryCategory,
  MemoryStats,
  SummaryEntry,
  SummaryStore,
  MemoryAction,
} from './types.ts'

const HOME = process.env.HOME || '/root'
export const DATA_DIR = process.env.PI_MEMORY_DIR || join(HOME, '.pi', 'memory')
export const ENTRIES_FILE = join(DATA_DIR, 'entries.json')
export const NOTES_FILE = join(DATA_DIR, 'notes.json')
export const SUMMARIES_FILE = join(DATA_DIR, 'summaries.json')
export const CHECKPOINTS_DIR = join(DATA_DIR, 'checkpoints')
const TMP_SUFFIX = '.tmp'
const MAX_MEMORY_SIZE = 1024 * 1024
export const STORE_VERSION = 2
export const SUMMARY_VERSION = 1
const PRUNE_CONFIDENCE = 0.3
const PRUNE_DAYS = 30
const PRUNE_RECURRENCE = 2
const PRUNE_DAYS_LOW = 60
const MAX_SUMMARIES = 50

// ctx-lite 旧位置（合并迁移）
const CTX_LITE_DIR = process.env.CTX_LITE_DIR || join(HOME, '.pi', 'ctx-lite')
const CTX_LITE_NOTES = join(CTX_LITE_DIR, 'notes.json')
const CTX_LITE_CHECKPOINTS = join(CTX_LITE_DIR, 'checkpoints')

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

function writeJSONAtomic(file: string, data: unknown) {
  ensureDir()
  const tmp = file + TMP_SUFFIX
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

// ── L1 长期记忆 ──────────────────────────────────────────────

export function loadEntries(): MemoryEntry[] {
  ensureDir()
  const store = readJSON<MemoryStore>(ENTRIES_FILE)
  if (!store || !Array.isArray(store.entries)) return []
  return store.entries.map(migrateEntry)
}

// v1 → v2：补充 observedAt；兼容旧 source 取值
function migrateEntry(e: MemoryEntry): MemoryEntry {
  if (!e.observedAt) e.observedAt = e.createdAt
  if (!e.id) e.id = randomUUID()
  if (typeof e.deleted !== 'boolean') e.deleted = false
  return e
}

export function saveEntries(entries: MemoryEntry[]) {
  writeJSONAtomic(ENTRIES_FILE, { version: STORE_VERSION, entries } satisfies MemoryStore)
}

export function activeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter(e => !e.deleted && !e.supersededBy)
}

// ── L2 会话摘要 ──────────────────────────────────────────────

export function loadSummaries(): SummaryEntry[] {
  ensureDir()
  const store = readJSON<SummaryStore>(SUMMARIES_FILE)
  if (!store || !Array.isArray(store.summaries)) return []
  return store.summaries
}

export function saveSummaries(summaries: SummaryEntry[]) {
  writeJSONAtomic(SUMMARIES_FILE, { version: SUMMARY_VERSION, summaries } satisfies SummaryStore)
}

export function appendSummary(summary: SummaryEntry): SummaryEntry[] {
  const all = loadSummaries()
  all.push(summary)
  const trimmed = all.length > MAX_SUMMARIES ? all.slice(-MAX_SUMMARIES) : all
  saveSummaries(trimmed)
  return trimmed
}

// ── L0 工作笔记（ctx-lite 合并） ─────────────────────────────

export function loadNotes(): Record<string, string> {
  ensureDir()
  migrateFromCtxLite()
  let notes = readJSON<Record<string, string>>(NOTES_FILE) || {}
  // 保留 _ctx. 内部键名（plan-mode 等扩展通过 lib/note-store 依赖它）

  // TTL 清理
  const now = Date.now()
  let changed = false
  for (const key of Object.keys(notes)) {
    const ttlKey = `__ttl_${key}`
    const ttl = notes[ttlKey]
    if (ttl && new Date(ttl).getTime() <= now) {
      delete notes[key]
      delete notes[ttlKey]
      changed = true
    }
  }
  if (changed) saveNotes(notes)
  return notes
}

export function saveNotes(notes: Record<string, string>) {
  writeJSONAtomic(NOTES_FILE, notes)
}

// ctx-lite 数据首次迁移：notes.json + checkpoints 复制到新目录
let ctxLiteMigrated = false
export function migrateFromCtxLite(): void {
  if (ctxLiteMigrated) return
  ctxLiteMigrated = true
  try {
    if (!existsSync(NOTES_FILE) && existsSync(CTX_LITE_NOTES)) {
      ensureDir()
      const raw = readFileSync(CTX_LITE_NOTES, 'utf-8')
      writeJSONAtomic(NOTES_FILE, JSON.parse(raw))
    }
    if (!existsSync(CHECKPOINTS_DIR) && existsSync(CTX_LITE_CHECKPOINTS)) {
      ensureDir()
      cpSync(CTX_LITE_CHECKPOINTS, CHECKPOINTS_DIR, { recursive: true })
    }
  } catch { /* 迁移失败不阻塞 */ }
}

export function clearCompactionFlag() {
  const notes = loadNotes()
  if (notes['_ctx.just_compacted']) {
    delete notes['_ctx.just_compacted']
    delete notes['_ctx.compacted_at']
    saveNotes(notes)
  }
}

export function getTotalSize(entries: MemoryEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + Buffer.byteLength(e.title + e.content, 'utf-8'),
    0,
  )
}

export function getNotesSize(notes: Record<string, string>): number {
  return Object.entries(notes)
    .filter(([k]) => !k.startsWith('__') && !k.startsWith('_ctx.'))
    .reduce((sum, [, v]) => sum + Buffer.byteLength(v, 'utf-8'), 0)
}

// ── 写入与消解 ───────────────────────────────────────────────

export function storeEntry(
  entries: MemoryEntry[],
  entry: MemoryEntry,
): { entries: MemoryEntry[]; action: 'created' | 'merged' | 'updated' } {
  const live = activeEntries(entries)

  const titleMatch = live.findIndex(
    e => e.title.toLowerCase() === entry.title.toLowerCase(),
  )
  if (titleMatch !== -1) {
    const e = live[titleMatch]
    e.content = entry.content
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    e.accessedAt = entry.accessedAt
    saveEntries(entries)
    return { entries, action: 'updated' }
  }

  const contentTokens = tokenize(entry.content)
  const mergeIdx = live.findIndex(e => {
    const existingTokens = tokenize(e.content)
    return jaccardSimilarity(contentTokens, existingTokens) > 0.7
  })
  if (mergeIdx !== -1) {
    const e = live[mergeIdx]
    if (contentTokens.length > tokenize(e.content).length) {
      e.content = entry.content
    }
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    e.accessedAt = entry.accessedAt
    saveEntries(entries)
    return { entries, action: 'merged' }
  }

  entries.push(entry)
  saveEntries(entries)
  return { entries, action: 'created' }
}

// Mem0 式四操作应用（决策由 merge.ts 生成）
export function applyMem0Action(
  entries: MemoryEntry[],
  action: MemoryAction,
  candidate: MemoryEntry,
  targetId?: string,
): { entries: MemoryEntry[]; applied: boolean } {
  switch (action) {
    case 'ADD': {
      entries.push(candidate)
      saveEntries(entries)
      return { entries, applied: true }
    }
    case 'UPDATE': {
      const idx = entries.findIndex(e => e.id === targetId)
      if (idx === -1) return { entries, applied: false }
      const e = entries[idx]
      e.content = candidate.content
      e.tags = [...new Set([...e.tags, ...candidate.tags])]
      e.confidence = Math.max(e.confidence, candidate.confidence)
      e.recurrence += 1
      e.updatedAt = candidate.updatedAt
      e.accessedAt = candidate.accessedAt
      if (candidate.observedAt) e.observedAt = candidate.observedAt
      saveEntries(entries)
      return { entries, applied: true }
    }
    case 'DELETE': {
      const idx = entries.findIndex(e => e.id === targetId)
      if (idx === -1) return { entries, applied: false }
      entries[idx].deleted = true
      entries[idx].updatedAt = new Date().toISOString()
      saveEntries(entries)
      return { entries, applied: true }
    }
    case 'NOOP':
      return { entries, applied: false }
  }
}

export function deleteEntry(entries: MemoryEntry[], id: string): boolean {
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  saveEntries(entries)
  return true
}

export function pruneEntries(entries: MemoryEntry[]): number {
  const now = Date.now()
  const before = entries.length
  const kept = entries.filter(e => {
    // 软删除/被取代条目直接回收（保留 superseded 统计用则仅回收 deleted）
    if (e.deleted) return false
    const age = now - new Date(e.accessedAt).getTime()
    const daysOld = age / (1000 * 60 * 60 * 24)
    if (e.confidence < PRUNE_CONFIDENCE && daysOld > PRUNE_DAYS) return false
    if (e.recurrence < PRUNE_RECURRENCE && daysOld > PRUNE_DAYS_LOW) return false
    return true
  })
  const removed = before - kept.length
  entries.length = 0
  entries.push(...kept)
  saveEntries(entries)
  return removed
}

export function getStats(entries: MemoryEntry[]): MemoryStats {
  const now = Date.now()
  const byCategory: Record<string, number> = {}
  let oldest: string | null = null
  let newest: string | null = null
  let cold = 0
  let superseded = 0

  for (const e of entries) {
    if (e.deleted) continue
    if (e.supersededBy) {
      superseded++
      continue
    }
    byCategory[e.category] = (byCategory[e.category] || 0) + 1

    if (!oldest || e.createdAt < oldest) oldest = e.createdAt
    if (!newest || e.createdAt > newest) newest = e.createdAt

    const age = now - new Date(e.accessedAt).getTime()
    if (age / (1000 * 60 * 60 * 24) > PRUNE_DAYS) cold++
  }

  return {
    totalEntries: entries.length,
    activeEntries: activeEntries(entries).length,
    byCategory,
    totalSizeBytes: getTotalSize(entries),
    oldestEntry: oldest,
    newestEntry: newest,
    coldEntries: cold,
    summaries: loadSummaries().length,
    superseded,
  }
}

// ── 词法工具 ─────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase()
    .split(/[\s,，。.、：:;；!！?？()（）\[\]【】{}""''\/\\\-_+#@$%^&*=|~`]+/)
    .filter(t => t.length > 0)
  // 中文补充 bigram，弥补无分词器时的检索盲区
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  if (cjk.length >= 2) {
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk.slice(i, i + 2))
    }
  }
  return tokens
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}
