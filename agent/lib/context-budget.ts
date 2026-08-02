/**
 * Context Budget — 跨扩展上下文预算 + token 估算 + 输出裁剪 + 缓存统计 统一模块
 *
 * 整合自 lib/token-budget.ts 与 lib/prune.ts：
 * - 统一 token 估算（中文 bigram 感知）
 * - 预算源支持真实 contextWindow 校准（不再硬编码 128K）
 * - 压力提示档位化（high/critical 才注入固定文案，保证 system prompt 字节级稳定 → 缓存命中）
 * - 输出裁剪预算按 token 计
 * - 缓存命中统计聚合（仅记录，供调试）
 *
 * 兼容 API：token-budget.ts / prune.ts 为 re-export 兼容层，调用方零改动。
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

// 档位化提示文案（固定文本，保证 system prompt 稳定 → 缓存前缀稳定）
const HIGH_PRESSURE_HINT =
  "🟡 上下文压力较高。优先将探索/独立任务委托给 subagent，关键信息用 ctx_note 保存。"
const CRITICAL_PRESSURE_HINT =
  "🔴 上下文接近满。请立即用 ctx_note 保存关键决策与进度，然后建议用户执行 /compact。"

export function setTotalBudget(budget: number): void {
  totalBudget = budget
}

// 用真实 contextWindow 校准总预算（事件层在 before_agent_start 调用）
export function setContextWindow(contextWindow: number): void {
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    totalBudget = contextWindow
  }
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

// 档位化压力标签：low/medium → null；high/critical → 固定文案
// （不再携带精确数值，避免每轮数值变化破坏 system prompt 缓存前缀）
export function getTokenPressureTag(): string | null {
  const r = getBudgetReport()
  if (r.pressure === "high") return HIGH_PRESSURE_HINT
  if (r.pressure === "critical") return CRITICAL_PRESSURE_HINT
  return null
}

export function resetBudget(): void {
  tokenUsageLog = []
}

export function getUrgencyHint(): string | null {
  const r = getBudgetReport()
  if (r.pressure === "critical") {
    return "🔴 上下文即将溢出。请用 ctx_note 保存关键决策、已完成工作和相关文件路径，然后通知用户执行 /compact 压缩上下文。"
  }
  if (r.pressure === "high") {
    return "🟠 上下文压力较大。建议保存关键信息。"
  }
  return null
}

// ── 统一 token 估算（中文感知） ──

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const digits = (text.match(/[0-9]/g) || []).length
  const other = text.length - cjk - digits
  return Math.ceil(cjk / 2 + digits / 3.5 + other / 4)
}

export function truncateByTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  // 按 token 预算换算目标字符数（逐段逼近，保守取 3/4）
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) low = mid
    else high = mid - 1
  }
  const truncated = text.slice(0, low)
  const ratio = text.length > 0 ? Math.round((truncated.length / text.length) * 100) : 0
  return `${truncated}\n\n[truncated: ${text.length} chars → ${truncated.length} chars (${ratio}%)]`
}

// ── 输出预算（按 token，整合自 prune.ts） ──

const OUTPUT_BUDGET_TOKENS = 20_000
const PER_TOOL_TOKENS = 5_000

interface OutputEntry {
  tool: string
  tokens: number
  ts: number
}

let outputEntries: OutputEntry[] = []
let outputTotalTokens = 0

export function recordOutput(tool: string, outputLength: number): void {
  // 兼容旧语义：调用方传字符长度；按 3.5 字符/token 保守折算（无法得知内容）
  const tokens = Math.ceil(outputLength / 3.5)
  outputEntries.push({ tool, tokens, ts: Date.now() })
  outputTotalTokens += tokens
}

export function pruneToolOutput(text: string, toolName: string): string {
  const textTokens = estimateTokens(text)
  const maxLenTokens = Math.min(PER_TOOL_TOKENS, Math.max(500, OUTPUT_BUDGET_TOKENS - outputTotalTokens))
  if (textTokens <= maxLenTokens && outputTotalTokens + textTokens <= OUTPUT_BUDGET_TOKENS) {
    return text
  }
  const allowed = Math.min(maxLenTokens, Math.max(300, OUTPUT_BUDGET_TOKENS - outputTotalTokens))
  if (allowed <= 0) {
    return `[${toolName} 输出已裁剪：累计输出已达预算上限]`
  }
  const ratio = Math.round((allowed / textTokens) * 100)
  const truncated = truncateByTokens(text, allowed)
  const truncatedText = truncated.replace(/\[truncated: [^\]]+\]$/, "")
  return `${truncatedText}\n\n[${toolName} 输出已截断：约 ${textTokens} token → ${allowed} token (${ratio}%)]`
}

export function getOutputReport(): string {
  if (outputEntries.length === 0) return ""
  const byTool = new Map<string, number>()
  for (const e of outputEntries) {
    byTool.set(e.tool, (byTool.get(e.tool) || 0) + e.tokens)
  }
  const lines = [
    `工具输出预算: ${outputTotalTokens.toLocaleString()}/${OUTPUT_BUDGET_TOKENS.toLocaleString()} token`,
  ]
  for (const [tool, tokens] of byTool) {
    lines.push(`  ${tool}: ${tokens.toLocaleString()} token`)
  }
  lines.push(`  剩余: ${Math.max(0, OUTPUT_BUDGET_TOKENS - outputTotalTokens).toLocaleString()} token`)
  return lines.join("\n")
}

export function resetOutputBudget(): void {
  outputEntries = []
  outputTotalTokens = 0
}

// ── 缓存命中统计（仅聚合，供调试/未来展示） ──

export interface CacheStats {
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
}

let cacheReadTotal = 0
let cacheWriteTotal = 0
let cacheCalls = 0

export function recordCacheUsage(cacheReadTokens?: number, cacheWriteTokens?: number): void {
  if (!cacheReadTokens && !cacheWriteTokens) return
  cacheReadTotal += cacheReadTokens || 0
  cacheWriteTotal += cacheWriteTokens || 0
  cacheCalls++
}

export function getCacheStats(): CacheStats {
  return {
    cacheReadTokens: cacheReadTotal,
    cacheWriteTokens: cacheWriteTotal,
    calls: cacheCalls,
  }
}

export function resetCacheStats(): void {
  cacheReadTotal = 0
  cacheWriteTotal = 0
  cacheCalls = 0
}

// ── 会话级重置（供 session_start 调用） ──

export function resetAllBudgets(): void {
  resetBudget()
  resetOutputBudget()
  resetCacheStats()
}
