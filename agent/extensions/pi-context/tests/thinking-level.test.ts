import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createState,
  tickThinkingLevel,
  clampToLadder,
  lower,
  upper,
  pressureOf,
  MIN_INTERVAL_MS,
  type AutoThinkLevel,
} from '../thinking-level.ts'
import { loadDiagLines } from '../../../lib/usage-diag.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thinking-level-'))
  process.env.PI_USAGE_DIAG_FILE = join(dir, 'diag.jsonl')
})

afterEach(() => {
  delete process.env.PI_USAGE_DIAG_FILE
  rmSync(dir, { recursive: true, force: true })
})

function makeNow(base = 1_000_000) {
  let t = base
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function recordEvents() {
  const calls: AutoThinkLevel[] = []
  const setLevel = (l: AutoThinkLevel) => calls.push(l)
  return { calls, setLevel }
}

describe('clampToLadder', () => {
  it('max→high、乱档归位', () => {
    expect(clampToLadder('max')).toBe('high')
    expect(clampToLadder('minimal')).toBe('low')
    expect(clampToLadder('off')).toBe('low')
    expect(clampToLadder('high')).toBe('high')
    expect(clampToLadder('medium')).toBe('medium')
  })
})

describe('pressureOf', () => {
  it('阈值边界', () => {
    expect(pressureOf(0.97)).toBe('critical')
    expect(pressureOf(0.8)).toBe('mid')
    expect(pressureOf(0.5)).toBe('low')
  })
})

describe('lower/upper', () => {
  it('阶梯方向正确且边界为 null', () => {
    expect(lower('high')).toBe('medium')
    expect(lower('low')).toBeNull()
    expect(upper('high')).toBeNull()
    expect(upper('low')).toBe('medium')
  })
})

describe('tickThinkingLevel', () => {
  it('critical 连续 2 次降挡并记账', () => {
    const s = createState('high')
    const { calls, setLevel } = recordEvents()
    const clk = makeNow()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('medium')
    expect(calls).toEqual(['medium'])
    expect(s.current).toBe('medium')
    const ev = loadDiagLines().find((l) => (l as { type?: string }).type === 'level-change')
    expect(ev).toBeTruthy()
    expect((ev as { from?: string }).from).toBe('high')
    expect((ev as { to?: string }).to).toBe('medium')
  })

  it('单次 critical 不降（防偶发）', () => {
    const s = createState('high')
    const { calls, setLevel } = recordEvents()
    const clk = makeNow()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.5, setLevel, clk.now())).toBeNull()
    expect(s.current).toBe('high')
    expect(calls).toEqual([])
  })

  it('已到下限不越（low 再 critical 不再降）', () => {
    const s = createState('medium')
    const { calls, setLevel } = recordEvents()
    const clk = makeNow()
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull() // streak=1
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('low')
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(s.current).toBe('low')
    expect(calls).toEqual(['low'])
  })

  it('回落 low 连续 3 次升回，不越基准', () => {
    const s = createState('high')
    const { calls, setLevel } = recordEvents()
    const clk = makeNow()
    // 降两档：high→(0.97×2)→medium →(间隔)→(0.97×2)→low
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('medium')
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('low')
    // 回落 low（真实比例下降）
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBeNull()
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBeNull()
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBe('medium')
    // 再升回 high
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBeNull()
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBeNull()
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBe('high')
    // 到基准后不再越
    clk.advance(MIN_INTERVAL_MS + 1)
    expect(tickThinkingLevel(s, 0.3, setLevel, clk.now())).toBeNull()
    expect(s.current).toBe('high')
    expect(calls.filter((x) => x !== 'high')).toEqual(['medium', 'low', 'medium'])
  })

  it('防抖死区：切换后时间窗内不再次切换', () => {
    const s = createState('high')
    const { setLevel } = recordEvents()
    const clk = makeNow()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('medium')
    // 死区内（未过 MIN_INTERVAL）继续 critical 不切
    clk.advance(MIN_INTERVAL_MS - 10)
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    // 死区解除后再 require 2 连
    clk.advance(20)
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.97, setLevel, clk.now())).toBe('low')
  })

  it('中段压力不清连续计数但也不切', () => {
    const s = createState('high')
    const { calls, setLevel } = recordEvents()
    const clk = makeNow()
    expect(tickThinkingLevel(s, 0.8, setLevel, clk.now())).toBeNull()
    expect(tickThinkingLevel(s, 0.9, setLevel, clk.now())).toBeNull()
    expect(s.criticalStreak).toBe(0)
    expect(s.lowStreak).toBe(0)
    expect(calls).toEqual([])
  })
})
