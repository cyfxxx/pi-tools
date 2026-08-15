import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  estimateTokens,
  setContextWindow,
  recordToolUsage,
  getBudgetReport,
  recordOutput,
  getOutputReport,
  resetOutputBudget,
  resetAllBudgets,
} from '../../../lib/context-budget.ts'

// 回归：跨扩展共享（jiti moduleCache:false 隔离修复）与累计语义/emoji 校准
describe('context-budget: 跨实例共享（jiti 隔离修复）', () => {
  beforeEach(() => resetAllBudgets())

  it('独立模块实例（模拟 jiti moduleCache:false）读写同一份状态', async () => {
    // 静态 import 实例 A；vi.resetModules 后再 import 得到全新实例 B。
    // 真实场景：pi SDK 用 createJiti({ moduleCache: false }) 为每个扩展
    // 生成独立模块实例（loader.js 实测），此前模块级状态互相不可见。
    const modA = await import('../../../lib/context-budget.ts')
    vi.resetModules()
    const modB = await import('../../../lib/context-budget.ts')

    modA.setContextWindow(64_000)
    modA.recordToolUsage('bash', 1000)
    modB.recordToolUsage('read', 500)

    // B 实例能看到 A 的窗口校准与用量（plan-mode 读侧场景）
    expect(modB.getBudgetReport().total).toBe(64_000)
    expect(modB.getBudgetReport().used).toBe(1500)
  })

  it('输出预算跨实例累计与重置（会话边界 resetOutputBudget）', async () => {
    const modA = await import('../../../lib/context-budget.ts')
    vi.resetModules()
    const modB = await import('../../../lib/context-budget.ts')

    modA.recordOutput('bash', 1000)
    modB.recordOutput('read', 500)
    expect(modA.getOutputReport()).toContain('bash')
    expect(modA.getOutputReport()).toContain('read')

    // 任一实例 reset（pi-memory session_start 调用）→ 全实例可见清零
    modB.resetOutputBudget()
    expect(modA.getOutputReport()).toBe('')
  })

  it('resetAllBudgets 复位窗口与全部用量（无残留）', () => {
    setContextWindow(64_000)
    recordToolUsage('bash', 100)
    resetAllBudgets()
    const r = getBudgetReport()
    expect(r.total).toBe(128_000)
    expect(r.used).toBe(0)
    expect(getOutputReport()).toBe('')
  })
})

describe('context-budget: used 累计语义（滚动窗口逐出不回退）', () => {
  beforeEach(() => resetAllBudgets())

  it('超过 MAX_LOG(50) 后 used 仍为会话累计总量', () => {
    setContextWindow(128_000)
    for (let i = 0; i < 60; i++) recordToolUsage('bash', 100)
    const r = getBudgetReport()
    // 旧实现：50 条滚动窗口求和 = 5000，逐出 10 条后反而下降；
    // 修复后：窗口外基量 + 窗口内求和 = 6000，与全量窗口比对语义正确
    expect(r.used).toBe(6000)
    expect(r.remaining).toBe(128_000 - 6000)
    expect(r.ratio).toBeCloseTo(6000 / 128_000)
  })

  it('topConsumers 仍基于滚动窗口（展示用途不受影响）', () => {
    for (let i = 0; i < 60; i++) recordToolUsage('bash', 100)
    const r = getBudgetReport()
    expect(r.topConsumers.length).toBeGreaterThan(0)
    expect(r.topConsumers[0].tokens).toBeLessThanOrEqual(50 * 100)
  })
})

describe('context-budget: emoji 按 1 token 保守校准', () => {
  beforeEach(() => resetAllBudgets())

  it('非 BMP 字符不再按 other/4 低估为 0.5 token', () => {
    expect(estimateTokens('🟡')).toBe(1)
    expect(estimateTokens('🔴🟠')).toBe(2)
    expect(estimateTokens('中文🟡')).toBe(2) // 2 CJK/2 + 1 emoji
  })

  it('纯文本估算保持既有行为（不含非 BMP 时结果不变）', () => {
    expect(estimateTokens('中文内容')).toBe(2)
    expect(estimateTokens('hello world')).toBe(3)
    expect(estimateTokens('1234567890')).toBe(3)
  })
})
