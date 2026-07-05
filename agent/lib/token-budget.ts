/**
 * Token Budget — cross-extension context pressure tracking
 *
 * Usage:
 *   import { recordToolUsage, getBudgetReport, getTokenPressureTag } from "../../lib/token-budget"
 */

export interface BudgetReport {
  used: number
  total: number
  remaining: number
  ratio: number
  pressure: "low" | "medium" | "high" | "critical"
  topConsumers: { tool: string; tokens: number }[]
}

const DEFAULT_TOTAL = 128_000
const MEDIUM_THRESHOLD = 0.7
const HIGH_THRESHOLD = 0.85
const CRITICAL_THRESHOLD = 0.95
const MAX_LOG = 50

interface UsageEntry {
  tool: string
  tokens: number
  timestamp: number
}

let tokenUsageLog: UsageEntry[] = []
let totalBudget = DEFAULT_TOTAL

export function setTotalBudget(budget: number): void {
  totalBudget = budget
}

export function recordToolUsage(tool: string, tokens: number): void {
  tokenUsageLog.push({ tool, tokens, timestamp: Date.now() })
  if (tokenUsageLog.length > MAX_LOG) {
    tokenUsageLog = tokenUsageLog.slice(-MAX_LOG)
  }
}

export function getBudgetReport(): BudgetReport {
  const used = tokenUsageLog.reduce((sum, e) => sum + e.tokens, 0)
  const ratio = totalBudget > 0 ? Math.min(1, used / totalBudget) : 0

  let pressure: BudgetReport["pressure"] = "low"
  if (ratio >= CRITICAL_THRESHOLD) pressure = "critical"
  else if (ratio >= HIGH_THRESHOLD) pressure = "high"
  else if (ratio >= MEDIUM_THRESHOLD) pressure = "medium"

  const consumerMap = new Map<string, number>()
  for (const e of tokenUsageLog) {
    consumerMap.set(e.tool, (consumerMap.get(e.tool) || 0) + e.tokens)
  }
  const topConsumers = Array.from(consumerMap.entries())
    .map(([tool, tokens]) => ({ tool, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)

  return {
    used,
    total: totalBudget,
    remaining: Math.max(0, totalBudget - used),
    ratio,
    pressure,
    topConsumers,
  }
}

export function getTokenPressureTag(): string | null {
  const r = getBudgetReport()
  if (r.pressure === "low") return null
  const icon = r.pressure === "critical" ? "🔴" : r.pressure === "high" ? "🟡" : "🟢"
  return `${icon}[ctx:${Math.round(r.ratio * 100)}% ${r.remaining.toLocaleString()}left]`
}

export function resetBudget(): void {
  tokenUsageLog = []
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

export function truncateByTokens(text: string, maxTokens: number): string {
  const targetLen = maxTokens * 3.5
  if (text.length <= targetLen) return text
  const ratio = text.length > 0 ? Math.round((targetLen / text.length) * 100) : 0
  const truncated = text.slice(0, Math.floor(targetLen))
  return `${truncated}\n\n[truncated: ${text.length} chars → ${truncated.length} chars (${ratio}%)]`
}
