import { describe, it, expect } from 'vitest'
import {
  computeCompactThreshold,
  makeCompactDecider,
  LARGE_WINDOW_SIZE,
  LARGE_WINDOW_RATIO,
  SMALL_WINDOW_RATIO,
  DEFAULT_COOLDOWN_MS,
} from '../../../lib/auto-compact.ts'

describe('auto-compact: 阈值计算', () => {
  it('1M 大窗口模型 → 20% 触发（deepseek-v4-flash 关键场景）', () => {
    expect(computeCompactThreshold(1_000_000)).toBe(Math.floor(1_000_000 * LARGE_WINDOW_RATIO))
    expect(computeCompactThreshold(1_000_000)).toBe(200_000)
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
})

describe('auto-compact: 判定与防抖', () => {
  const now = 1_000_000

  it('未超阈值 → 不压缩', () => {
    const d = makeCompactDecider()
    const decision = d.decide(100_000, 1_000_000, now)
    expect(decision.shouldCompact).toBe(false)
    expect(decision.reason).toBe('over-threshold')
    expect(decision.threshold).toBe(200_000)
  })

  it('超阈值 → 触发压缩', () => {
    const d = makeCompactDecider()
    const decision = d.decide(250_000, 1_000_000, now)
    expect(decision.shouldCompact).toBe(true)
    expect(decision.contextTokens).toBe(250_000)
  })

  it('压缩后 cooldown 内不再触发（防压缩循环）', () => {
    const d = makeCompactDecider()
    expect(d.decide(250_000, 1_000_000, now).shouldCompact).toBe(true)
    d.markCompact(now)
    const second = d.decide(300_000, 1_000_000, now + DEFAULT_COOLDOWN_MS - 1)
    expect(second.shouldCompact).toBe(false)
    expect(second.reason).toBe('cooldown')
  })

  it('cooldown 过后可再次触发', () => {
    const d = makeCompactDecider()
    d.markCompact(now)
    const second = d.decide(300_000, 1_000_000, now + DEFAULT_COOLDOWN_MS)
    expect(second.shouldCompact).toBe(true)
  })

  it('markCompact 会记录时间戳（decide 本身不改变状态）', () => {
    const d = makeCompactDecider()
    expect(d.lastCompactAt).toBe(0)
    expect(d.decide(250_000, 1_000_000, now).shouldCompact).toBe(true)
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
