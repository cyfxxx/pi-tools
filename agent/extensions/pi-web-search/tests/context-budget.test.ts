import { describe, it, expect, beforeEach } from 'vitest'
import {
  estimateTokens,
  truncateByTokens,
  setContextWindow,
  recordToolUsage,
  getBudgetReport,
  getTokenPressureTag,
  getUrgencyHint,
  resetAllBudgets,
  recordOutput,
  pruneToolOutput,
  getOutputReport,
  recordCacheUsage,
  getCacheStats,
} from '../../../lib/context-budget'

describe('context-budget: estimateTokens', () => {
  beforeEach(() => resetAllBudgets())

  it('counts CJK at 2 chars/token', () => {
    expect(estimateTokens('中文内容')).toBe(2)
    expect(estimateTokens('项目管理与运维')).toBe(4)
  })

  it('counts latin at 4 chars/token and digits at 3.5', () => {
    expect(estimateTokens('hello world')).toBe(3)
    expect(estimateTokens('1234567890')).toBe(3)
  })

  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('context-budget: pressure tiers are stable', () => {
  beforeEach(() => resetAllBudgets())

  it('low pressure → no tag', () => {
    setContextWindow(128_000)
    recordToolUsage('bash', 1000)
    expect(getTokenPressureTag()).toBeNull()
  })

  it('medium pressure → no tag (threshold raised for cache stability)', () => {
    setContextWindow(100)
    recordToolUsage('bash', 75)
    expect(getTokenPressureTag()).toBeNull()
  })

  it('high pressure → fixed stable hint text', () => {
    setContextWindow(100)
    recordToolUsage('bash', 90)
    const a = getTokenPressureTag()
    const b = getTokenPressureTag()
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(a!).toContain('压力较高')
  })

  it('critical pressure → fixed stable hint text', () => {
    setContextWindow(100)
    recordToolUsage('bash', 99)
    const a = getTokenPressureTag()
    const b = getTokenPressureTag()
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(a!).toContain('接近满')
  })

  it('urgency hint is fixed text (no volatile numbers)', () => {
    setContextWindow(100)
    recordToolUsage('bash', 99)
    const hint = getUrgencyHint()
    expect(hint).not.toBeNull()
    expect(hint).toBe(getUrgencyHint())
  })
})

describe('context-budget: report', () => {
  beforeEach(() => resetAllBudgets())

  it('setContextWindow calibrates total', () => {
    setContextWindow(64_000)
    const r = getBudgetReport()
    expect(r.total).toBe(64_000)
  })

  it('topConsumers ranks by usage', () => {
    setContextWindow(128_000)
    recordToolUsage('bash', 300)
    recordToolUsage('read', 500)
    recordToolUsage('bash', 200)
    const r = getBudgetReport()
    expect(r.topConsumers[0].tool).toBe('bash')
    expect(r.topConsumers[0].tokens).toBe(500)
  })
})

describe('context-budget: truncateByTokens', () => {
  beforeEach(() => resetAllBudgets())

  it('returns text unchanged when within budget', () => {
    expect(truncateByTokens('hello', 10)).toBe('hello')
  })

  it('truncates to approximate token budget', () => {
    const text = '中文'.repeat(200) + ' english words here'
    const out = truncateByTokens(text, 50)
    // 截断主体贴近预算（标记行本身另计 ~6 token，2026-08-18 精简标记后）
    expect(estimateTokens(out)).toBeLessThanOrEqual(60)
    expect(out).toContain('[截断]')
  })
})

describe('context-budget: output budget (prune merged)', () => {
  beforeEach(() => resetAllBudgets())

  it('keeps output within per-tool budget untouched', () => {
    const out = pruneToolOutput('short output', 'bash')
    expect(out).toBe('short output')
  })

  it('truncates oversized output with marker', () => {
    const big = 'x'.repeat(50_000)
    const out = pruneToolOutput(big, 'bash')
    expect(out).toContain('[bash 输出已截断：')
  })

  it('records per-tool output and reports', () => {
    recordOutput('bash', 100)
    const report = getOutputReport()
    expect(report).toContain('bash')
    expect(report).toContain('token')
  })

  it('resetOutputBudget clears report', () => {
    recordOutput('bash', 100)
    resetAllBudgets()
    expect(getOutputReport()).toBe('')
  })
})

describe('context-budget: cache stats', () => {
  beforeEach(() => resetAllBudgets())

  it('aggregates cache read/write tokens', () => {
    recordCacheUsage(1000, 50)
    recordCacheUsage(2000)
    const stats = getCacheStats()
    expect(stats.cacheReadTokens).toBe(3000)
    expect(stats.cacheWriteTokens).toBe(50)
    expect(stats.calls).toBe(2)
  })

  it('ignores empty records', () => {
    recordCacheUsage()
    expect(getCacheStats().calls).toBe(0)
  })
})
