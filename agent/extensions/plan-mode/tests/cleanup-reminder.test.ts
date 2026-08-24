import { describe, it, expect } from 'vitest'
import { cleanupReminderCheck } from '../state.ts'

describe('plan-mode: 清理提醒判定（2026-08-24）', () => {
  const completed = { status: 'completed' as const }
  const pending = { status: 'pending' as const }

  it('无 completed 任务时计数归零、不提醒', () => {
    const r = cleanupReminderCheck(2, false, [pending, pending])
    expect(r).toEqual({ turns: 0, remind: false, done: 0 })
  })

  it('有 completed 任务时每轮 +1，满 3 轮且未碰 todo 才提醒', () => {
    const r1 = cleanupReminderCheck(0, false, [completed])
    expect(r1).toEqual({ turns: 1, remind: false, done: 1 })
    const r2 = cleanupReminderCheck(r1.turns, false, [completed])
    expect(r2.remind).toBe(false)
    const r3 = cleanupReminderCheck(r2.turns, false, [completed])
    expect(r3).toEqual({ turns: 0, remind: true, done: 1 })
  })

  it('提醒后计数归零（防每轮刷屏）', () => {
    const r = cleanupReminderCheck(2, false, [completed])
    expect(r.remind).toBe(true)
    expect(r.turns).toBe(0)
    const r2 = cleanupReminderCheck(r.turns, false, [completed])
    expect(r2.remind).toBe(false)
    expect(r2.turns).toBe(1)
  })

  it('本轮碰过 todo 工具（可能正在清理）不提醒，但计数照常累计', () => {
    const r = cleanupReminderCheck(2, true, [completed])
    expect(r).toEqual({ turns: 3, remind: false, done: 1 })
  })

  it('count 混合列表只统计 completed', () => {
    const r = cleanupReminderCheck(2, false, [completed, pending, completed])
    expect(r).toEqual({ turns: 0, remind: true, done: 2 })
  })
})