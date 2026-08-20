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

export function buildDoc(e: MemoryEntry): DocTokens {
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

// 质量分：置信度 + 时效（指数衰减，半衰期约 62 天）+ 引用频率（归一化 0-1）
export function qualityScore(e: MemoryEntry): number {
  const now = Date.now()
  const daysOld = (now - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  const recency = Math.exp(-daysOld / 90)
  const recurrence = Math.min(e.recurrence / 10, 1)
  return e.confidence * 0.5 + recency * 0.25 + recurrence * 0.25
}

/** 条目间主题相似度（token Jaccard，轻量）——MMR 多样性用。 */
function tokenJaccard(a: DocTokens, b: DocTokens): number {
  const inter = new Set<string>()
  for (const t of a.all) if (b.all.has(t)) inter.add(t)
  const union = a.all.size + b.all.size - inter.size
  return union === 0 ? 0 : inter.size / union
}

interface Scored { e: MemoryEntry; score: number }

/** bi-temporal 可见性：在 asOf 时刻该条目是否有效（2026-08-20，graphiti 时间窗思想本地化）。 */
export function visibleAt(e: MemoryEntry, asOfTs: number): boolean {
  if (asOfTs < new Date(e.createdAt).getTime()) return false // 尚未创建
  if (e.supersededBy || e.deleted) {
    if (e.validUntil) return new Date(e.validUntil).getTime() > asOfTs
    return false // 软删无失效时间 → 保守视为不可回溯
  }
  return true
}

/**
 * 轻量 MMR（Maximal Marginal Relevance）多样性重排：
 * 每轮取 score 最高且与已选条目相似度最低的候选（lambda 高=重相关，低=重多样）。
 * 借鉴 ruflo SmartRetrieval 的 MMR 阶段，防注入块主题冗余。
 *
 * Banding（缓存友好限制）：与最高分差距 < bandRatio（默认 15%）的高分条目
 * 直接按原序锚定（不参与多样性重排）——新条目的加入不会重排高分前缀，
 * 注入块前部保持稳定（KV 缓存前缀命中）；多样性只作用于分数相近的尾部 band。
 */
export function mmrDiversify(
  ranked: Scored[],
  limit: number,
  lambda = 0.7,
  docs: Map<string, DocTokens>,
  bandRatio = 0.15,
): Scored[] {
  if (ranked.length <= limit) return ranked
  const topScore = ranked[0]?.score ?? 0
  const anchorThreshold = topScore * (1 - bandRatio)
  // 高分锚定：按原序直接取（缓存稳定）
  const chosen: Scored[] = ranked.filter(r => r.score >= anchorThreshold)
  if (chosen.length >= limit) return chosen.slice(0, limit)
  // 尾部 band：仅对分数相近的候选做 MMR 多样性选择
  const pool = ranked.filter(r => r.score < anchorThreshold)
  while (chosen.length < limit && pool.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      let maxSim = 0
      for (const c of chosen) {
        const sim = tokenJaccard(docs.get(pool[i].e.id)!, docs.get(c.e.id)!)
        if (sim > maxSim) maxSim = sim
      }
      const v = lambda * pool[i].score - (1 - lambda) * maxSim
      if (v > bestVal) {
        bestVal = v
        bestIdx = i
      }
    }
    chosen.push(pool.splice(bestIdx, 1)[0])
  }
  return chosen.slice(0, limit)
}

/**
 * 跨会话 round-robin：按 sessionId 分组轮转交错，防单会话垄断注入/检索结果。
 * （ruflo SmartRetrieval 的 session round-robin 阶段）
 */
export function roundRobinBySession(ranked: Scored[], limit: number): Scored[] {
  const groups = new Map<string, Scored[]>()
  const order: string[] = []
  for (const item of ranked) {
    const key = item.e.lastSessionId ?? '__none__'
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(item)
  }
  const out: Scored[] = []
  let idx = 0
  let guard = 0
  while (out.length < limit && guard < ranked.length * 2) {
    guard++
    const key = order[idx % order.length]
    const group = groups.get(key)!
    const item = group.shift()
    if (item) out.push(item)
    idx++
    if (order.every(k => (groups.get(k)!.length === 0))) break
  }
  return out.slice(0, limit)
}

export interface SearchOptions {
  category?: MemoryCategory
  tags?: string[]
  limit?: number
  /** 环境过滤：缺省不过滤；传具体环境则只返回 all + 该环境条目 */
  env?: RuntimeEnv | 'all'
}

// 混合检索：有 query 时 70% 词法 + 30% 质量；无 query 时纯质量
// asOf（ISO 时间点）可选：返回“在该时刻有效”的记忆（bi-temporal 回溯查询）。
// 规则：createdAt ≤ asOf；被取代/软删条目须 validUntil > asOf 才可见（无 validUntil 视为不可回溯）；
// 活跃条目始终可见（除非 asOf < createdAt）。缺省走 activeEntries（当前态），注入路径不变。
export function searchEntries(
  entries: MemoryEntry[],
  query?: string,
  category?: MemoryCategory,
  tags?: string[],
  limit = 5,
  env?: RuntimeEnv | 'all',
  asOf?: string,
): MemoryEntry[] {
  let live: MemoryEntry[]
  if (asOf) {
    const asOfTs = new Date(asOf).getTime()
    if (Number.isNaN(asOfTs)) return []
    live = entries.filter(e => visibleAt(e, asOfTs))
  } else {
    live = activeEntries(entries)
  }
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
    const ranked = live
      .map(e => ({ e, score: qualityScore(e) }))
      .sort((a, b) => b.score - a.score)
    return roundRobinBySession(ranked, limit).map(x => x.e)
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

  const ranked = live
    .map((e, i) => ({
      e,
      score: 0.7 * bm25Score(queryTokens, docs[i], df, n, avgLen) + 0.3 * qualityScore(e),
    }))
    .sort((a, b) => b.score - a.score)

  // MMR 主题多样性（需先建 id→DocTokens 映射）+ 跨会话轮转
  const docMap = new Map(live.map((e, i) => [e.id, docs[i]]))
  const diversified = mmrDiversify(ranked, limit, 0.7, docMap)
  return roundRobinBySession(diversified, limit).map(x => x.e)
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
