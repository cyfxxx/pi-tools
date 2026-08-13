import type { MemoryAction, MemoryEntry } from './types.ts'
import { activeEntries, tokenize, jaccardSimilarity, saveEntries, applyMem0Action, mergeEnvironments } from './storage.ts'
import { findSimilar } from './retrieval.ts'

export interface MergeDecision {
  action: MemoryAction
  targetId?: string
  note: string
}

// Mem0 式规则消解：候选记忆 vs 相似既有记忆 → ADD/UPDATE/DELETE/NOOP
// 无需额外 LLM 调用（提取已由 LLM 完成，此处纯规则判定）

// 对立词对：同一主体上语义反转的表达（双向匹配）
const OPPOSITE_PAIRS: Array<[string, string]> = [
  ['喜欢', '不喜欢'], ['喜欢', '讨厌'], ['喜欢', '厌恶'],
  ['启用', '禁用'], ['启用', '关闭'], ['开启', '关闭'], ['开启', '禁用'],
  ['支持', '反对'],
  ['需要', '不需要'],
  ['有用', '无用'], ['好用', '不好用'],
  ['能', '不能'], ['能', '无法'],
  ['会', '不会'],
  ['是', '不是'],
  ['继续', '停止'],
  ['正常', '异常'], ['正常', '故障'],
]

/**
 * 矛盾检测：双方各含对立词之一（如 A 含"喜欢"、B 含"不喜欢"），
 * 且去词后有 ≥2 个公共 token（bigram 也算）证明讨论同一主体。
 * 判定矛盾 → 新候选取代旧条目（superseded），而非合并。
 */
export function detectContradiction(existing: MemoryEntry, candidate: MemoryEntry): boolean {
  const A = existing.content.toLowerCase()
  const B = candidate.content.toLowerCase()
  let hit = false
  for (const [x, y] of OPPOSITE_PAIRS) {
    if ((A.includes(x) && B.includes(y)) || (A.includes(y) && B.includes(x))) {
      hit = true
      break
    }
  }
  if (!hit) return false
  // 主体重叠验证：公共 token（含中文 bigram）≥2
  const aToks = new Set(tokenize(A))
  const bToks = new Set(tokenize(B))
  let common = 0
  for (const t of aToks) {
    if (bToks.has(t) && t.length >= 2) common++
  }
  return common >= 2
}

export async function decideMerge(
  entries: MemoryEntry[],
  candidate: MemoryEntry,
): Promise<MergeDecision> {
  const similar = await findSimilar(entries, candidate, 3)
  if (similar.length === 0) {
    return { action: 'ADD', note: '无相似条目' }
  }

  const best = similar[0]
  const j = best.jaccard
  const live = activeEntries(entries)
  const titleMatch = live.find(
    e => e.title.toLowerCase() === candidate.title.toLowerCase(),
  )

  // 标题精确匹配 → 更新
  if (titleMatch) {
    return {
      action: 'UPDATE',
      targetId: titleMatch.id,
      note: `标题匹配: ${titleMatch.title}`,
    }
  }

  // 矛盾检测：同一主体的对立表达（喜欢→不喜欢）→ 取代而非合并
  // 先于相似度合并判断，避免"用户喜欢咖啡"被并入"用户不喜欢咖啡"
  if (detectContradiction(best.entry, candidate)) {
    best.entry.supersededBy = candidate.id
    best.entry.deleted = true
    best.entry.updatedAt = new Date().toISOString()
    return {
      action: 'ADD',
      note: `矛盾取代 ${best.entry.title}（语义反转，已标记 superseded）`,
    }
  }

  // 内容几乎相同且候选置信度不更高 → 跳过
  if (j > 0.9 && candidate.confidence <= best.entry.confidence) {
    return { action: 'NOOP', note: '已有等价且更优条目' }
  }

  // 内容高度相似 → 更新既有（补充信息）
  if (j > 0.7) {
    return {
      action: 'UPDATE',
      targetId: best.entry.id,
      note: `内容相似度 ${j.toFixed(2)}`,
    }
  }

  // 冲突检测：同类别 + 标签有交集 + 内容不相似 + 新候选置信度更高 → 取代旧条目
  const tagOverlap = candidate.tags.some(t =>
    best.entry.tags.some(bt => bt.toLowerCase() === t.toLowerCase()),
  )
  if (
    j < 0.3 &&
    best.entry.category === candidate.category &&
    tagOverlap &&
    candidate.confidence >= best.entry.confidence &&
    best.entry.source !== 'manual'
  ) {
    best.entry.supersededBy = candidate.id
    best.entry.deleted = true
    best.entry.updatedAt = new Date().toISOString()
    return {
      action: 'ADD',
      note: `取代冲突条目 ${best.entry.title}（已标记 superseded）`,
    }
  }

  return { action: 'ADD', note: '新信息' }
}

// 批量消解：对一组候选逐个决策并应用
export async function mergeCandidates(
  entries: MemoryEntry[],
  candidates: MemoryEntry[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = []
  const skipped: string[] = []
  for (const candidate of candidates) {
    const decision = await decideMerge(entries, candidate)
    if (decision.action === 'NOOP') {
      skipped.push(candidate.title)
      continue
    }
    if (decision.action === 'ADD') {
      entries.push(candidate)
      applied.push(`ADD: ${candidate.title}`)
      continue
    }
    if (decision.action === 'UPDATE' && decision.targetId) {
      const idx = entries.findIndex(e => e.id === decision.targetId)
      if (idx !== -1) {
        const e = entries[idx]
        e.content = candidate.content.length > e.content.length ? candidate.content : e.content
        e.tags = [...new Set([...e.tags, ...candidate.tags])]
        e.confidence = Math.max(e.confidence, candidate.confidence)
        e.recurrence += 1
        e.updatedAt = candidate.updatedAt
        e.observedAt = candidate.observedAt || e.observedAt
        e.environments = mergeEnvironments(e.environments, candidate.environments)
        applied.push(`UPDATE: ${e.title}`)
      }
      continue
    }
    if (decision.action === 'DELETE' && decision.targetId) {
      const idx = entries.findIndex(e => e.id === decision.targetId)
      if (idx !== -1) {
        entries[idx].deleted = true
        entries[idx].updatedAt = new Date().toISOString()
        applied.push(`DELETE: ${entries[idx].title}`)
      }
    }
  }
  // 冲突取代时 entry 已在 decideMerge 内被标记，最后统一持久化
  saveEntries(entries)
  return { applied, skipped }
}

export { jaccardSimilarity }
export function similarity(a: string[], b: string[]): number {
  return jaccardSimilarity(a, b)
}

// 供工具层直接对单候选出决策并落盘
export async function resolveAndApply(
  entries: MemoryEntry[],
  candidate: MemoryEntry,
): Promise<MergeDecision & { applied: boolean }> {
  const decision = await decideMerge(entries, candidate)
  if (decision.action === 'ADD') {
    entries.push(candidate)
    saveEntries(entries)
    return { ...decision, applied: true }
  }
  const { applied } = applyMem0Action(entries, decision.action, candidate, decision.targetId)
  saveEntries(entries)
  return { ...decision, applied }
}
