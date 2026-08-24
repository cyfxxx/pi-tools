import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  recordUsage,
  recordAutoCompact,
  recordThinkingMeter,
  loadDiagLines,
  summarizeRecords,
  formatUsageSummary,
  getDiagFile,
  trimDiagContent,
  recordToolCall,
  loadToolUseEvents,
  pruneToolEvents,
  recomputeToolUsage,
  toolUseFile,
  getToolUsageFile,
  type UsageRecord,
  type ThinkingMeterEvent,
  type ToolUseEvent,
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

  it('recordThinkingMeter 写入 thinking-meter 事件', () => {
    recordThinkingMeter(12_345)
    const ev = loadDiagLines().find(
      (l) => (l as { type?: string }).type === 'thinking-meter',
    ) as unknown as ThinkingMeterEvent | undefined
    expect(ev).toBeTruthy()
    expect(ev!.tokens).toBe(12_345)
    expect(ev!.type).toBe('thinking-meter')
  })
})

describe('usage-diag: 工具调用事件日志（跨设备/30 天）', () => {
  let edir: string

  beforeEach(() => {
    edir = mkdtempSync(join(tmpdir(), 'tool-events-'))
    // 隔离目录：事件目录 + 聚合文件 + 设备标识
    process.env.PI_TOOL_EVENTS_DIR = edir
    process.env.PI_TOOL_USAGE_FILE = join(edir, 'tool-usage.json')
    process.env.PI_DEVICE_ID = 'test-host'
  })

  afterEach(() => {
    process.env = { ...ORIG_ENV }
    rmSync(edir, { recursive: true, force: true })
  })

  it('无条件记录：无 usage 回传也留痕（时间戳/工具/估算输出）', () => {
    recordToolCall({ tool: 'bash', outputTokens: 123 })
    recordToolCall({ tool: 'read', outputTokens: 456, input: 10, cacheRead: 20 })
    const events = loadToolUseEvents(true, 30)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool-use', device: 'test-host', tool: 'bash', outputTokens: 123 })
    expect(events[0].ts).toBeGreaterThan(0)
    expect(events[0].iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(events[0].eid).toMatch(/^test-host:/)
    expect(events[1].input).toBe(10)
    expect(events[1].cacheRead).toBe(20)
  })

  it('设备独立文件：本机事件不写他人文件', () => {
    recordToolCall({ tool: 'bash', outputTokens: 1 })
    expect(toolUseFile('test-host')).toContain('tool-use-test-host.jsonl')
    const lines = readToolEventsFile(edir, 'test-host')
    expect(lines).toHaveLength(1)
    expect(lines[0].tool).toBe('bash')
  })

  it('30 天窗口过滤：超窗事件不进入聚合', () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000
    const ev: ToolUseEvent = {
      type: 'tool-use', eid: 'test-host:0:old', device: 'test-host',
      ts: old, iso: new Date(old).toISOString(), tool: 'bash', outputTokens: 1,
    }
    writeToolEventsDir(edir, 'test-host', ev)
    recordToolCall({ tool: 'read', outputTokens: 2 })
    const events = loadToolUseEvents(true, 30)
    expect(events.map((e) => e.tool)).toEqual(['read'])
  })

  it('recompute 聚合含 first/lastTs 与 device 分桶，且 eid 去重', () => {
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000
    const dup: ToolUseEvent = {
      type: 'tool-use', eid: 'phone:1:1', device: 'phone',
      ts: old, iso: new Date(old).toISOString(), tool: 'edit', outputTokens: 5,
    }
    // 同一事件重复写两行（模拟 pull 竞态）
    writeToolEventsDir(edir, 'phone', dup, dup)
    recordToolCall({ tool: 'bash', outputTokens: 3 })
    const all = recomputeToolUsage(30)
    expect(all['edit'].calls).toBe(1) // eid 去重
    expect(all['edit'].byDevice['phone'].calls).toBe(1)
    expect(all['bash'].byDevice['test-host'].calls).toBe(1)
    expect(all['bash'].firstTs).toBeGreaterThan(0)
    expect(all['bash'].lastTs).toBeGreaterThanOrEqual(all['bash'].firstTs)
    // 聚合文件已写
    expect(existsSync(getToolUsageFile())).toBe(true)
  })

  it('pruneToolEvents 只清本机超窗事件', () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000
    const remote: ToolUseEvent = {
      type: 'tool-use', eid: 'phone:1:old', device: 'phone',
      ts: old, iso: new Date(old).toISOString(), tool: 'read', outputTokens: 1,
    }
    writeToolEventsDir(edir, 'phone', remote)
    // 本机 31 天前事件（先写旧，再 append 当天事件）
    const ownOld = { ...remote, eid: 'test-host:0:old', device: 'test-host' }
    writeToolEventsDir(edir, 'test-host', ownOld)
    recordToolCall({ tool: 'bash', outputTokens: 1 })
    const removed = pruneToolEvents(30, 'test-host')
    expect(removed).toBe(1)
    // 他人文件不受影响（超窗事件仍在）
    expect(readToolEventsFile(edir, 'phone')).toHaveLength(1)
    // 本机剩 1 条（当天的 bash）
    expect(readToolEventsFile(edir, 'test-host')).toHaveLength(1)
  })
})

// ── 测试辅助 ──
function readToolEventsFile(dir: string, device: string): ToolUseEvent[] {
  const f = join(dir, `tool-use-${device}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function writeToolEventsDir(dir: string, device: string, ...events: ToolUseEvent[]): void {
  const f = join(dir, `tool-use-${device}.jsonl`)
  writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}
