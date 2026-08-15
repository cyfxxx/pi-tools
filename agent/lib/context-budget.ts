/**
 * Context Budget — 跨扩展上下文预算 + token 估算 + 输出裁剪 + 缓存统计 统一模块
 *
 * 整合自 lib/token-budget.ts 与 lib/prune.ts：
 * - 统一 token 估算（中文 bigram 感知，emoji 按 1 token 保守校准）
 * - 预算源支持真实 contextWindow 校准（不再硬编码 128K）
 * - 压力提示档位化（high/critical 才注入固定文案，保证 system prompt 字节级稳定 → 缓存命中）
 * - 输出裁剪预算按 token 计
 * - 缓存命中统计聚合（仅记录，供调试）
 *
 * 跨扩展共享（jiti 模块隔离修复）：pi SDK 扩展加载器用
 * createJiti({ moduleCache: false })（dist/core/extensions/loader.js 实测），
 * 每个扩展得到独立的模块实例——模块级 let 状态无法跨扩展共享
 * （实测症状：plan-mode 读不到 pi-web-search/pi-browser/pi-memory 记录的用量，
 * 压力档位恒为 low；totalBudget 恒为默认 128K）。状态是会话级
 * （session_start 重置，无跨进程持久化需求），故挂载在 globalThis +
 * Symbol.for 单例上：同一 Node 进程内所有 jiti 实例共享同一 globalThis
 * 与 Symbol 注册表，跨扩展读写一致。
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

interface OutputEntry {
  tool: string
  tokens: number
  ts: number
}

interface SharedBudgetState {
  // 滚动窗口（仅用于 topConsumers 展示）
  tokenUsageLog: UsageEntry[]
  // 会话累计使用总量：窗口逐出旧条目不回退（修复"滚动窗口求和 vs 全量窗口比对"语义失真）
  usedTotal: number
  totalBudget: number
  outputEntries: OutputEntry[]
  outputTotalTokens: number
  cacheReadTotal: number
  cacheWriteTotal: number
  cacheCalls: number
}

const STATE_KEY = Symbol.for("pi.context-budget.state")

function getState(): SharedBudgetState {
  const g = globalThis as Record<symbol, SharedBudgetState | undefined>
  let s = g[STATE_KEY]
  if (!s) {
    s = {
      tokenUsageLog: [],
      usedTotal: 0,
      totalBudget: DEFAULT_TOTAL,
      outputEntries: [],
      outputTotalTokens: 0,
      cacheReadTotal: 0,
      cacheWriteTotal: 0,
      cacheCalls: 0,
    }
    g[STATE_KEY] = s
  }
  return s
}

// 档位化提示文案（固定文本，保证 system prompt 稳定 → 缓存前缀稳定）
const HIGH_PRESSURE_HINT =
  "🟡 上下文压力较高。优先将探索/独立任务委托给 subagent，关键信息用 ctx_note 保存。"
const CRITICAL_PRESSURE_HINT =
  "🔴 上下文接近满。请立即用 ctx_note 保存关键决策与进度，然后建议用户执行 /compact。"

export function setTotalBudget(budget: number): void {
  getState().totalBudget = budget
}

// 用真实 contextWindow 校准总预算（事件层在 before_agent_start 调用）
export function setContextWindow(contextWindow: number): void {
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    getState().totalBudget = contextWindow
  }
}

// 真实用量校准（审计 MEDIUM：plan-mode/pi-web-search 的压力提示依赖 usedTotal，
// 但 recordToolUsage 只统计上报过的工具输出——与真实上下文用量口径不一致）。
// pi-context 在 before_agent_start 用 ctx.getContextUsage() 拿到真实 tokens 后调用本函数覆盖。
export function setUsedTokens(used: number): void {
  const s = getState()
  if (Number.isFinite(used) && used >= 0) {
    // 取 max：report 制累计不回退（会话内单调），真实校准只升不降
    s.usedTotal = Math.max(s.usedTotal, used)
  }
}

export function recordToolUsage(tool: string, tokens: number): void {
  const s = getState()
  s.tokenUsageLog.push({ tool, tokens, timestamp: Date.now() })
  if (s.tokenUsageLog.length > MAX_LOG) {
    s.tokenUsageLog = s.tokenUsageLog.slice(-MAX_LOG)
  }
  // 累计总量不回退：used 与全量 contextWindow 的比值随会话单调增长，
  // 不再出现"旧条目逐出越多 used 反而下降"的失真
  s.usedTotal += tokens
}

export function getBudgetReport(): BudgetReport {
  const s = getState()
  const used = s.usedTotal
  const ratio = s.totalBudget > 0 ? Math.min(1, used / s.totalBudget) : 0

  let pressure: BudgetReport["pressure"] = "low"
  if (ratio >= CRITICAL_THRESHOLD) pressure = "critical"
  else if (ratio >= HIGH_THRESHOLD) pressure = "high"
  else if (ratio >= MEDIUM_THRESHOLD) pressure = "medium"

  const consumerMap = new Map<string, number>()
  for (const e of s.tokenUsageLog) {
    consumerMap.set(e.tool, (consumerMap.get(e.tool) || 0) + e.tokens)
  }
  const topConsumers = Array.from(consumerMap.entries())
    .map(([tool, tokens]) => ({ tool, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)

  return {
    used,
    total: s.totalBudget,
    remaining: Math.max(0, s.totalBudget - used),
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
  const s = getState()
  s.tokenUsageLog = []
  s.usedTotal = 0
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

// ── 统一 token 估算（中文感知，emoji 保守校准） ──

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const digits = (text.match(/[0-9]/g) || []).length
  // 非 BMP 字符（emoji/代理对，如 🟡🔴）：常见 tokenizer 按 1-2 token 计；
  // 原先落入 other 按 /4 只计 0.5 token，低估约一倍。按 1 token/个保守校准
  // （含 ZWJ/变体选择符的复杂 emoji 为多代理对，按对计数自然偏高，保守方向正确）。
  const astral = (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g) || []).length
  const other = text.length - cjk - digits - astral * 2
  return Math.ceil(cjk / 2 + digits / 3.5 + astral + other / 4)
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

export function recordOutput(tool: string, outputLength: number): void {
  // 兼容旧语义：调用方传字符长度；按 3.5 字符/token 保守折算（无法得知内容）
  const tokens = Math.ceil(outputLength / 3.5)
  const s = getState()
  s.outputEntries.push({ tool, tokens, ts: Date.now() })
  s.outputTotalTokens += tokens
}

export function pruneToolOutput(text: string, toolName: string): string {
  const s = getState()
  const textTokens = estimateTokens(text)
  const maxLenTokens = Math.min(PER_TOOL_TOKENS, Math.max(500, OUTPUT_BUDGET_TOKENS - s.outputTotalTokens))
  if (textTokens <= maxLenTokens && s.outputTotalTokens + textTokens <= OUTPUT_BUDGET_TOKENS) {
    return text
  }
  const allowed = Math.min(maxLenTokens, Math.max(300, OUTPUT_BUDGET_TOKENS - s.outputTotalTokens))
  if (allowed <= 0) {
    return `[${toolName} 输出已裁剪：累计输出已达预算上限]`
  }
  const ratio = Math.round((allowed / textTokens) * 100)
  const truncated = truncateByTokens(text, allowed)
  const truncatedText = truncated.replace(/\[truncated: [^\]]+\]$/, "")
  return `${truncatedText}\n\n[${toolName} 输出已截断：约 ${textTokens} token → ${allowed} token (${ratio}%)]`
}

export function getOutputReport(): string {
  const s = getState()
  if (s.outputEntries.length === 0) return ""
  const byTool = new Map<string, number>()
  for (const e of s.outputEntries) {
    byTool.set(e.tool, (byTool.get(e.tool) || 0) + e.tokens)
  }
  const lines = [
    `工具输出预算: ${s.outputTotalTokens.toLocaleString()}/${OUTPUT_BUDGET_TOKENS.toLocaleString()} token`,
  ]
  for (const [tool, tokens] of byTool) {
    lines.push(`  ${tool}: ${tokens.toLocaleString()} token`)
  }
  lines.push(`  剩余: ${Math.max(0, OUTPUT_BUDGET_TOKENS - s.outputTotalTokens).toLocaleString()} token`)
  return lines.join("\n")
}

export function resetOutputBudget(): void {
  const s = getState()
  s.outputEntries = []
  s.outputTotalTokens = 0
}

// ── 缓存命中统计（仅聚合，供调试/未来展示） ──

export interface CacheStats {
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
}

export function recordCacheUsage(cacheReadTokens?: number, cacheWriteTokens?: number): void {
  if (!cacheReadTokens && !cacheWriteTokens) return
  const s = getState()
  s.cacheReadTotal += cacheReadTokens || 0
  s.cacheWriteTotal += cacheWriteTokens || 0
  s.cacheCalls++
}

export function getCacheStats(): CacheStats {
  const s = getState()
  return {
    cacheReadTokens: s.cacheReadTotal,
    cacheWriteTokens: s.cacheWriteTotal,
    calls: s.cacheCalls,
  }
}

export function resetCacheStats(): void {
  const s = getState()
  s.cacheReadTotal = 0
  s.cacheWriteTotal = 0
  s.cacheCalls = 0
}

// ── 会话级重置（供 session_start 调用） ──

export function resetAllBudgets(): void {
  resetBudget()
  resetOutputBudget()
  resetCacheStats()
  // 上下文窗口一并复位（与 TOKEN-BUDGET.md 约定一致），保证测试/复用场景下无残留
  getState().totalBudget = DEFAULT_TOTAL
}
