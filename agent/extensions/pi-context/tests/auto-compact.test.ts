import { describe, it, expect } from 'vitest'
import {
  computeCompactThreshold,
  makeCompactDecider,
  makeAutoContinueGate,
  LARGE_WINDOW_SIZE,
  LARGE_WINDOW_RATIO,
  SMALL_WINDOW_RATIO,
  DEFAULT_COOLDOWN_MS,
} from '../../../lib/auto-compact.ts'

describe('auto-compact: 阈值计算', () => {
  it('1M 大窗口模型 → 80% 触发（对齐 dsh thresholdRatio 0.8，deepseek-v4 关键场景）', () => {
    expect(computeCompactThreshold(1_000_000)).toBe(Math.floor(1_000_000 * LARGE_WINDOW_RATIO))
    expect(computeCompactThreshold(1_000_000)).toBe(800_000)
  })

  it('小窗口模型（local-llama 131K）→ 85% 触发，不干扰原生压缩', () => {
    expect(computeCompactThreshold(131_072)).toBe(Math.floor(131_072 * SMALL_WINDOW_RATIO))
  })

  it('窗口边界 256K：等于归小窗口档，大于才归大窗口档', () => {
    expect(computeCompactThreshold(LARGE_WINDOW_SIZE)).toBe(Math.floor(LARGE_WINDOW_SIZE * SMALL_WINDOW_RATIO))
    expect(computeCompactThreshold(LARGE_WINDOW_SIZE + 1)).toBe(Math.floor((LARGE_WINDOW_SIZE + 1) * LARGE_WINDOW_RATIO))
  })

  it('无效窗口 → null（不触发）', () => {
    expect(computeCompactThreshold(0)).toBeNull()
    expect(computeCompactThreshold(-1)).toBeNull()
    expect(computeCompactThreshold(Number.NaN)).toBeNull()
  })

  it('opts 覆盖（env/策略可调）：自定义大窗口比例生效', () => {
    expect(computeCompactThreshold(1_000_000, { largeRatio: 0.6 })).toBe(600_000)
    expect(computeCompactThreshold(100_000, { smallRatio: 0.9 })).toBe(90_000)
    expect(computeCompactThreshold(600_000, { largeWindowSize: 500_000, largeRatio: 0.5 })).toBe(300_000)
  })

  it('absoluteTokens 绝对阈值优先（用户策略 200K，不随窗口比例浮动）', () => {
    expect(computeCompactThreshold(1_000_000, { absoluteTokens: 200_000 })).toBe(200_000)
    expect(computeCompactThreshold(131_072, { absoluteTokens: 200_000 })).toBe(200_000)
    expect(computeCompactThreshold(1_000_000, { absoluteTokens: 0 })).toBe(800_000) // <=0 退回比例
    expect(computeCompactThreshold(1_000_000, { absoluteTokens: 200_000, largeRatio: 0.5 })).toBe(200_000)
  })
})

describe('auto-compact: 判定与防抖', () => {
  const now = 1_000_000

  it('未超阈值 → 不压缩', () => {
    const d = makeCompactDecider()
    const decision = d.decide(100_000, 1_000_000, now)
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('under-threshold')
    expect(decision.threshold).toBe(800_000)
  })

  it('超阈值 → 触发压缩', () => {
    const d = makeCompactDecider()
    const decision = d.decide(850_000, 1_000_000, now)
    expect(decision.shouldCompact).toBe(true)
    expect(decision.contextTokens).toBe(850_000)
  })

  it('decider opts 覆盖 + 冷却独立生效', () => {
    const d = makeCompactDecider(60_000, { largeRatio: 0.5 })
    expect(d.decide(600_000, 1_000_000, now).shouldCompact).toBe(true)
    expect(d.decide(600_000, 1_000_000, now + 10_000).reason).toBe('over-threshold') // 60s 冷却内第二次仍超阈值
    d.markCompact(now)
    expect(d.decide(600_000, 1_000_000, now + 10_000).reason).toBe('cooldown')
    expect(d.decide(600_000, 1_000_000, now + 70_000).shouldCompact).toBe(true)
  })

  it('压缩后 cooldown 内不再触发（防压缩循环）', () => {
    const d = makeCompactDecider()
    expect(d.decide(850_000, 1_000_000, now).shouldCompact).toBe(true)
    d.markCompact(now)
    const second = d.decide(900_000, 1_000_000, now + DEFAULT_COOLDOWN_MS - 1)
    expect(second.shouldCompact).toBe(false)
    expect(second.reason).toBe('cooldown')
  })

  it('cooldown 过后可再次触发', () => {
    const d = makeCompactDecider()
    d.markCompact(now)
    const second = d.decide(900_000, 1_000_000, now + DEFAULT_COOLDOWN_MS)
    expect(second.shouldCompact).toBe(true)
  })

  it('markCompact 会记录时间戳（decide 本身不改变状态）', () => {
    const d = makeCompactDecider()
    expect(d.lastCompactAt).toBe(0)
    expect(d.decide(850_000, 1_000_000, now).shouldCompact).toBe(true)
    expect(d.lastCompactAt).toBe(0)
    d.markCompact(now)
    expect(d.lastCompactAt).toBe(now)
  })

  it('无窗口 → no-window 不触发', () => {
    const d = makeCompactDecider()
    const decision = d.decide(500_000, 0, now)
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('no-window')
  })
})

describe('auto-continue gate: 压缩后自动继续', () => {
  it('默认 arm 后 shouldContinue 返回 true（压缩成功 → 自动继续）', () => {
    const g = makeAutoContinueGate()
    expect(g.armed).toBe(false)
    g.arm()
    expect(g.armed).toBe(true)
    expect(g.shouldContinue()).toBe(true)
    expect(g.armed).toBe(false) // 一次性
  })

  it('未 arm（如手动 /compact）→ shouldContinue 返回 false', () => {
    const g = makeAutoContinueGate()
    expect(g.shouldContinue()).toBe(false)
  })

  it('压缩失败 disarm 后不再自动继续', () => {
    const g = makeAutoContinueGate()
    g.arm()
    g.disarm()
    expect(g.shouldContinue()).toBe(false)
    expect(g.armed).toBe(false)
  })

  it('enabled=false 时 arm 无效（开关关闭）', () => {
    const g = makeAutoContinueGate(false)
    g.arm()
    expect(g.armed).toBe(false)
    expect(g.shouldContinue()).toBe(false)
  })

  it('连续两次 shouldContinue 只返回一次 true', () => {
    const g = makeAutoContinueGate()
    g.arm()
    expect(g.shouldContinue()).toBe(true)
    expect(g.shouldContinue()).toBe(false)
  })
})
