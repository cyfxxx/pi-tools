import type { MemoryEntry, MemoryCategory } from './types.ts'
import { activeEntries, tokenize } from './storage.ts'
import { isEnvVisible, type RuntimeEnv } from './env.ts'

const K1 = 1.5
const B = 0.75
const FIELD_WEIGHT = { title: 3, tags: 2, content: 1 } as const

interface DocTokens {
  title: string[]
  tags: string[]
  content: string[]
  all: Set<string>
}

function buildDoc(e: MemoryEntry): DocTokens {
  const title = tokenize(e.title)
  const tags = e.tags.flatMap(t => tokenize(t))
  const content = tokenize(e.content)
  return {
    title,
    tags,
    content,
    all: new Set([...title, ...tags, ...content]),
  }
}

function docLength(d: DocTokens): number {
  return d.title.length * FIELD_WEIGHT.title + d.tags.length * FIELD_WEIGHT.tags + d.content.length * FIELD_WEIGHT.content
}

// 词法相关性（BM25 式）：词频饱和 + 文档长度归一 + IDF
export function bm25Score(
  queryTokens: string[],
  doc: DocTokens,
  df: Map<string, number>,
  n: number,
  avgLen: number,
): number {
  const len = docLength(doc)
  let score = 0
  for (const q of queryTokens) {
    const tf =
      doc.title.filter(t => t.includes(q) || q.includes(t)).length * FIELD_WEIGHT.title +
      doc.tags.filter(t => t.includes(q) || q.includes(t)).length * FIELD_WEIGHT.tags +
      doc.content.filter(t => t.includes(q) || q.includes(t)).length * FIELD_WEIGHT.content
    if (tf === 0) continue
    const docFreq = df.get(q) ?? 0
    const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5))
    score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / (avgLen || 1))))
  }
  return score
}

// 质量分：置信度 + 时效 + 引用频率（归一化 0-1）
export function qualityScore(e: MemoryEntry): number {
  const now = Date.now()
  const daysOld = (now - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  const recency = Math.max(0, 1 - daysOld / 180)
  const recurrence = Math.min(e.recurrence / 10, 1)
  return e.confidence * 0.5 + recency * 0.25 + recurrence * 0.25
}

export interface SearchOptions {
  category?: MemoryCategory
  tags?: string[]
  limit?: number
  /** 环境过滤：缺省不过滤；传具体环境则只返回 all + 该环境条目 */
  env?: RuntimeEnv | 'all'
}

// 混合检索：有 query 时 70% 词法 + 30% 质量；无 query 时纯质量
export function searchEntries(
  entries: MemoryEntry[],
  query?: string,
  category?: MemoryCategory,
  tags?: string[],
  limit = 5,
  env?: RuntimeEnv | 'all',
): MemoryEntry[] {
  let live = activeEntries(entries)
  if (!live.length) return []
  if (env && env !== 'all') {
    live = live.filter(e => isEnvVisible(e.environments, env))
  }
  if (category) live = live.filter(e => e.category === category)
  if (tags && tags.length > 0) {
    const lowerTags = tags.map(t => t.toLowerCase())
    live = live.filter(e =>
      lowerTags.some(t => e.tags.some(et => et.toLowerCase() === t)),
    )
  }
  if (!live.length) return []

  const queryTokens = query ? tokenize(query) : []

  if (queryTokens.length === 0) {
    return live
      .map(e => ({ e, score: qualityScore(e) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.e)
  }

  const docs = live.map(e => buildDoc(e))
  const n = live.length
  const avgLen = docs.reduce((s, d) => s + docLength(d), 0) / n

  // 文档频率（词法匹配：包含或互为子串）
  const df = new Map<string, number>()
  for (const q of queryTokens) {
    let count = 0
    for (const d of docs) {
      if ([...d.all].some(t => t.includes(q) || q.includes(t))) count++
    }
    df.set(q, count)
  }

  return live
    .map((e, i) => ({
      e,
      score: 0.7 * bm25Score(queryTokens, docs[i], df, n, avgLen) + 0.3 * qualityScore(e),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.e)
}

// 提取/消解用：找与候选最相似的条目（内容 Jaccard + 词法）
export function findSimilar(
  entries: MemoryEntry[],
  candidate: MemoryEntry,
  topK = 3,
): Array<{ entry: MemoryEntry; jaccard: number; lexical: number }> {
  const live = activeEntries(entries)
  const cTokens = tokenize(candidate.content)
  const cTitle = tokenize(candidate.title)
  const docs = live.map(e => buildDoc(e))
  const n = live.length || 1
  const avgLen = docs.reduce((s, d) => s + docLength(d), 0) / n
  const query = [...cTitle, ...cTokens.slice(0, 8)]
  const df = dfFor(docs, query)

  const scored = live.map((e, i) => ({
    entry: e,
    jaccard: jaccardScore(cTokens, docs[i].content),
    lexical: bm25Score(query, docs[i], df, n, avgLen),
  }))
  return scored
    .sort((a, b) => b.jaccard - a.jaccard || b.lexical - a.lexical)
    .slice(0, topK)
}

function dfFor(docs: DocTokens[], tokens: string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const q of tokens) {
    let count = 0
    for (const d of docs) {
      if ([...d.all].some(t => t.includes(q) || q.includes(t))) count++
    }
    df.set(q, count)
  }
  return df
}

function jaccardScore(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  const inter = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : inter.size / union.size
}
