import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry, MemoryStore, MemoryCategory, MemoryStats } from './types.ts'

const HOME = process.env.HOME || '/root'
export const DATA_DIR = process.env.PI_MEMORY_DIR || join(HOME, '.pi', 'memory')
export const ENTRIES_FILE = join(DATA_DIR, 'entries.json')
const TMP_FILE = ENTRIES_FILE + '.tmp'
const MAX_MEMORY_SIZE = 1024 * 1024
const STORE_VERSION = 1
const PRUNE_CONFIDENCE = 0.3
const PRUNE_DAYS = 30
const PRUNE_RECURRENCE = 2
const PRUNE_DAYS_LOW = 60

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

export function loadEntries(): MemoryEntry[] {
  ensureDir()
  try {
    const raw: MemoryStore = JSON.parse(readFileSync(ENTRIES_FILE, 'utf-8'))
    return raw.entries || []
  } catch {
    return []
  }
}

function saveEntries(entries: MemoryEntry[]) {
  ensureDir()
  const store: MemoryStore = { version: STORE_VERSION, entries }
  writeFileSync(TMP_FILE, JSON.stringify(store, null, 2))
  renameSync(TMP_FILE, ENTRIES_FILE)
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .split(/[\s,，。.、：:;；!！?？()（）\[\]【】{}""''\/\\\-_+#@$%^&*=|~`]+/)
    .filter(t => t.length > 0)
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

function scoreEntry(e: MemoryEntry, keywords?: string[]): number {
  const now = Date.now()
  const age = now - new Date(e.createdAt).getTime()
  const daysOld = age / (1000 * 60 * 60 * 24)

  let score = e.confidence * 0.3
  score += Math.max(0, 1 - daysOld / 90) * 0.2
  score += Math.min(e.recurrence / 10, 1) * 0.15

  if (e.category === 'preference') score += 0.1
  if (e.category === 'habit') score += 0.05

  if (keywords && keywords.length > 0) {
    const titleTokens = tokenize(e.title)
    const tagTokens = e.tags.flatMap(t => tokenize(t))
    const contentTokens = tokenize(e.content)
    const allTokens = new Set([...titleTokens, ...tagTokens, ...contentTokens])

    let titleHits = 0, tagHits = 0, contentHits = 0
    for (const kw of keywords) {
      if (titleTokens.some(t => t.includes(kw) || kw.includes(t))) titleHits++
      if (tagTokens.some(t => t.includes(kw) || kw.includes(t))) tagHits++
      if (contentTokens.some(t => t.includes(kw) || kw.includes(t))) contentHits++
    }

    score += (titleHits / keywords.length) * 0.25
    score += (tagHits / keywords.length) * 0.1
    score += (contentHits / keywords.length) * 0.05
  }

  return score
}

export function searchEntries(
  entries: MemoryEntry[],
  query?: string,
  category?: MemoryCategory,
  tags?: string[],
  limit = 5,
): MemoryEntry[] {
  let filtered = entries.filter(e => e.confidence > 0)

  if (category) {
    filtered = filtered.filter(e => e.category === category)
  }

  if (tags && tags.length > 0) {
    const lowerTags = tags.map(t => t.toLowerCase())
    filtered = filtered.filter(e =>
      lowerTags.some(t => e.tags.some(et => et.toLowerCase() === t)),
    )
  }

  if (!filtered.length) return []

  const keywords = query ? tokenize(query) : undefined

  let scored = filtered.map(e => ({ entry: e, score: scoreEntry(e, keywords) }))

  if (keywords && keywords.length > 0) {
    const tokenSets = filtered.map(e => {
      const titleTokens = tokenize(e.title)
      const tagTokens = e.tags.flatMap(t => tokenize(t))
      const contentTokens = tokenize(e.content)
      return new Set([...titleTokens, ...tagTokens, ...contentTokens])
    })
    scored = scored.filter((_, i) => {
      const tokens = tokenSets[i]
      return keywords.some(kw => [...tokens].some(t => t.includes(kw) || kw.includes(t)))
    })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

export function storeEntry(
  entries: MemoryEntry[],
  entry: MemoryEntry,
): { entries: MemoryEntry[]; action: 'created' | 'merged' | 'updated' } {
  const titleMatch = entries.findIndex(
    e => e.title.toLowerCase() === entry.title.toLowerCase(),
  )
  if (titleMatch !== -1) {
    const e = entries[titleMatch]
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
  const mergeIdx = entries.findIndex(e => {
    const existingTokens = tokenize(e.content)
    return jaccardSimilarity(contentTokens, existingTokens) > 0.7
  })
  if (mergeIdx !== -1) {
    const e = entries[mergeIdx]
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

export function getTotalSize(entries: MemoryEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + Buffer.byteLength(e.title + e.content, 'utf-8'),
    0,
  )
}

export function getStats(entries: MemoryEntry[]): MemoryStats {
  const now = Date.now()
  const byCategory: Record<string, number> = {}
  let oldest: string | null = null
  let newest: string | null = null
  let cold = 0

  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1

    if (!oldest || e.createdAt < oldest) oldest = e.createdAt
    if (!newest || e.createdAt > newest) newest = e.createdAt

    const age = now - new Date(e.accessedAt).getTime()
    if (age / (1000 * 60 * 60 * 24) > PRUNE_DAYS) cold++
  }

  return {
    totalEntries: entries.length,
    byCategory,
    totalSizeBytes: getTotalSize(entries),
    oldestEntry: oldest,
    newestEntry: newest,
    coldEntries: cold,
  }
}
