import { describe, it, expect } from 'vitest'
import { resolvePlanModeEnabled, capQaMessages } from '../index'

function qa(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message-${i}`,
  }))
}

describe('resolvePlanModeEnabled: 会话恢复时 --plan 启动标志优先', () => {
  it('有 --plan 标志时，持久化 enabled=false 不覆盖（LOW 审计回归）', () => {
    expect(resolvePlanModeEnabled(true, false, true)).toBe(true)
  })

  it('有 --plan 标志且无持久化条目 → 启用', () => {
    expect(resolvePlanModeEnabled(true, undefined, false)).toBe(true)
  })

  it('无标志：持久化 enabled=true → 恢复启用', () => {
    expect(resolvePlanModeEnabled(false, true, false)).toBe(true)
  })

  it('无标志：持久化 enabled=false → 保持关闭', () => {
    expect(resolvePlanModeEnabled(false, false, false)).toBe(false)
  })

  it('无标志且无持久化值 → 沿用当前值', () => {
    expect(resolvePlanModeEnabled(false, undefined, true)).toBe(true)
    expect(resolvePlanModeEnabled(undefined, undefined, false)).toBe(false)
  })
})

describe('capQaMessages: 持久化 qaMessages 尾部截断（会话膨胀防护）', () => {
  it('超过上限只保留尾部 20 条', () => {
    const capped = capQaMessages(qa(30))
    expect(capped).toHaveLength(20)
    expect(capped[0].content).toBe('message-10')
    expect(capped[19].content).toBe('message-29')
  })

  it('未超上限原样返回', () => {
    const small = qa(5)
    expect(capQaMessages(small)).toHaveLength(5)
    expect(capQaMessages(small)).toEqual(small)
  })

  it('空数组 → 空数组', () => {
    expect(capQaMessages([])).toEqual([])
  })
})
