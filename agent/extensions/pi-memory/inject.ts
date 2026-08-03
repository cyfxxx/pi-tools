import type { MemoryEntry, SummaryEntry } from './types.ts'
import { activeEntries } from './storage.ts'
import { qualityScore } from './retrieval.ts'
import { estimateTokens } from '../../lib/context-budget.ts'

export const INJECT_TAG = 'pi-memory-injection'
export const DEFAULT_BUDGET_TOKENS = 500

export function getBudget(): number {
  const env = process.env.PI_MEMORY_INJECT_TOKENS
  const n = env ? parseInt(env, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_TOKENS
}

export interface InjectionResult {
  block: string
  entries: number
  summaries: number
  tokens: number
}

// 每轮常驻注入块（MemGPT 核心块思路）：
// 1) 高价值长期记忆（质量分排序）
// 2) 最近会话摘要衔接（L2）
// 预算内截断，防止上下文膨胀
export function buildInjectionBlock(
  entries: MemoryEntry[],
  summaries: SummaryEntry[],
  budgetTokens: number = getBudget(),
): InjectionResult {
  const live = activeEntries(entries)

  const lines: string[] = []
  lines.push('## 持续记忆（pi-memory 自动注入，每轮刷新）')
  lines.push(
    '以下是跨会话长期记忆。用到时直接使用；新发现的重要信息请用 memory_store 工具主动存入（会话结束也会自动提取）。',
  )
  let used = estimateTokens(lines.join('\n') + '\n')
  let injectedEntries = 0
  let injectedSummaries = 0

  // L1 高价值条目（仅对候选子集排序：预算/条数上限远小于条目总数）
  if (live.length > 0) {
    const maxRank = Math.min(live.length, 32)
    const ranked = [...live]
      .sort((a, b) => qualityScore(b) - qualityScore(a))
      .slice(0, maxRank)
    for (const e of ranked) {
      const item = `- [${e.category}] ${e.title}: ${e.content.slice(0, 200)}`
      const cost = estimateTokens(item + '\n')
      if (used + cost > budgetTokens && injectedEntries > 0) break
      if (used + cost > budgetTokens * 2) break
      lines.push(item)
      used += cost
      injectedEntries++
      if (injectedEntries >= 6) break
    }
  }

  // L2 最近会话衔接（最多 2 条摘要）
  const recent = summaries.slice(-2).reverse()
  for (const s of recent) {
    const item = `- 会话「${s.title}」: ${(s.fullText || s.decisions.join('; ')).slice(0, 200)}`
    const cost = estimateTokens(item + '\n')
    if (used + cost > budgetTokens && injectedSummaries > 0) break
    lines.push(item)
    used += cost
    injectedSummaries++
  }

  // 恒定标记行（无时间戳：时间戳每轮变化会破坏 system prompt 缓存前缀，使全部消息历史缓存失效）
  lines.push(`> ${INJECT_TAG}`)
  const block = lines.join('\n')
  return { block, entries: injectedEntries, summaries: injectedSummaries, tokens: estimateTokens(block) }
}

// 判断一段文本是否为注入块（供测试/过滤使用）
export function isInjectionBlock(text: string): boolean {
  return text.includes(INJECT_TAG)
}
