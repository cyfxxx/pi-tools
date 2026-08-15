import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  recordUsage,
  recordAutoCompact,
  loadDiagLines,
  summarizeRecords,
  formatUsageSummary,
  getDiagFile,
  trimDiagContent,
  type UsageRecord,
} from '../../../lib/usage-diag.ts'

let dir: string
const ORIG_ENV = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-diag-'))
  process.env.PI_USAGE_DIAG_FILE = join(dir, 'diag.jsonl')
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_USAGE_DIAG_FILE
  rmSync(dir, { recursive: true, force: true })
})

function record(overrides: Partial<UsageRecord>): void {
  recordUsage({
    ts: Date.now(),
    input: 10_000,
    cacheRead: 20_000,
    cacheWrite: 0,
    output: 500,
    reasoning: 100,
    total: 30_600,
    contextTokens: 30_000,
    compacted: false,
    ...overrides,
  })
}

describe('usage-diag: 记录与读取', () => {
  it('记录后可从文件读回', () => {
    record({ input: 5_000 })
    const lines = loadDiagLines()
    expect(lines).toHaveLength(1)
    expect((lines[0] as UsageRecord).input).toBe(5_000)
  })

  it('auto-compact 事件与用量记录共存', () => {
    record({})
    recordAutoCompact(250_000, 200_000)
    const lines = loadDiagLines()
    expect(lines).toHaveLength(2)
    const event = lines.find((l) => 'type' in l)
    expect(event).toMatchObject({ type: 'auto-compact', contextTokens: 250_000, threshold: 200_000 })
  })

  it('损坏行被跳过，不影响其余记录', () => {
    record({})
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(getDiagFile(), 'not json\n')
    record({})
    expect(loadDiagLines()).toHaveLength(2)
  })

  it('trimDiagContent 超上限截断保留尾部，未超限返回 null', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n') + '\n'
    const out = trimDiagContent(lines, 10)
    expect(out).not.toBeNull()
    expect(out!.split('\n').filter(Boolean)).toHaveLength(10)
    expect(out).toContain('line2')
    expect(out).toContain('line11')
    expect(out).not.toContain('line1\n')
    expect(trimDiagContent('a\nb\n', 10)).toBeNull()
  })
})

describe('usage-diag: 汇总', () => {
  it('空记录 → null', () => {
    expect(summarizeRecords([])).toBeNull()
  })

  it('汇总统计正确（总量/平均/峰值/缓存命中率）', () => {
    record({ input: 10_000, cacheRead: 30_000 }) // 30/40 = 75%
    record({ input: 20_000, cacheRead: 0 }) // 0%
    record({ input: 30_000, cacheRead: 30_000 }) // 50%
    const s = summarizeRecords(loadDiagLines().filter((l): l is UsageRecord => !('type' in l)))
    expect(s).not.toBeNull()
    expect(s!.requests).toBe(3)
    expect(s!.inputTotal).toBe(60_000)
    expect(s!.inputAvg).toBe(20_000)
    expect(s!.inputMax).toBe(30_000)
    expect(s!.cacheReadTotal).toBe(60_000)
    expect(s!.cacheHitRatio).toBe(50)
    expect(s!.recentTrend).toHaveLength(3)
  })

  it('formatUsageSummary 输出关键行', () => {
    record({ input: 10_000, cacheRead: 30_000 })
    record({ input: 15_000, cacheRead: 35_000 })
    const text = formatUsageSummary(loadDiagLines())
    expect(text).toContain('请求数: 2')
    expect(text).toContain('缓存命中: 65.0K (72%)')
    expect(text).toContain('自动压缩触发: 0 次')
  })

  it('formatUsageSummary 包含自动压缩事件信息', () => {
    record({})
    recordAutoCompact(250_000, 200_000)
    const text = formatUsageSummary(loadDiagLines())
    expect(text).toContain('自动压缩触发: 1 次')
    expect(text).toContain('250.0K')
  })

  it('无记录时给出提示', () => {
    expect(formatUsageSummary([])).toContain('暂无用量记录')
  })
})
