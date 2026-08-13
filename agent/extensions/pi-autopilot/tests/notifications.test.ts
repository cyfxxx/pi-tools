import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let TEST_DIR = ''
let LOG_DIR = ''

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')

// 必须在 import '../notifications' 之前设置：storage.ts 顶层 `const AGENT_DIR = getAgentDir()`
// 在模块收集期求值，beforeAll 里再设置会因时序拿到 mock 默认值（/tmp 路径，Termux 无 /tmp）。
TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-scheduler-notif-'))
__setAgentDir(TEST_DIR)
// logDir() = AGENT_DIR/../logs/scheduler，需与扩展实现一致；先清残留避免跨运行污染
LOG_DIR = join(TEST_DIR, '..', 'logs', 'scheduler')

beforeAll(async () => {
  await rm(LOG_DIR, { recursive: true, force: true })
  await mkdir(LOG_DIR, { recursive: true })
})

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { collectOfflineExecutions, markRead, formatSummary } = await import('../notifications')

describe('collectOfflineExecutions', () => {
  it('collects cron-format log files', async () => {
    await writeFile(join(LOG_DIR, 'my-task.log'), 'my-task | success | 20260801T100000\nhello output\nsecond line')
    await writeFile(join(LOG_DIR, 'other-task.log'), 'other-task | failure | 20260801T093000\nerror details')
    const entries = await collectOfflineExecutions()
    expect(entries).toHaveLength(2)
    const first = entries.find(e => e.name === 'my-task')!
    expect(first.result).toBe('success')
    expect(first.time).toBe('20260801T100000')
    expect(first.output).toContain('hello output')
    expect(first.output).toContain('second line')
    expect(first.filename).toBe('my-task.log')
  })

  it('returns empty when log dir is missing', async () => {
    const { rm, mkdir } = await import('fs/promises')
    await rm(LOG_DIR, { recursive: true, force: true })
    expect(await collectOfflineExecutions()).toHaveLength(0)
    await mkdir(LOG_DIR, { recursive: true })
  })

  it('skips non-task logs without header separator (wrapper-ensure.log)', async () => {
    // wrapper-ensure.log 是 install-wrapper 追加输出，无 "name | result | ts" 头
    await writeFile(join(LOG_DIR, 'wrapper-ensure.log'), 'ensure 输出无 header 格式\n')
    await writeFile(join(LOG_DIR, 'real-task.log'), 'real-task | success | 20260801T100000\nok')
    const entries = await collectOfflineExecutions()
    expect(entries.some(e => e.filename === 'wrapper-ensure.log')).toBe(false)
    expect(entries.some(e => e.filename === 'real-task.log')).toBe(true)
  })
})

describe('markRead', () => {
  it('renames file with .read suffix', async () => {
    await writeFile(join(LOG_DIR, 'temp-task.log'), 'temp-task | success | 20260801T100000\n')
    let entries = await collectOfflineExecutions()
    const target = entries.find(e => e.filename === 'temp-task.log')!
    expect(target.name).toBe('temp-task')
    await markRead(target)
    entries = await collectOfflineExecutions()
    expect(entries.some(e => e.filename === 'temp-task.log')).toBe(false)
    const { readdir } = await import('fs/promises')
    const files = await readdir(LOG_DIR)
    expect(files).toContain('temp-task.log.read')
  })

  it('ignores missing files', async () => {
    await expect(markRead({ name: 'x', result: 'success', time: '', output: '', filename: 'ghost.log' })).resolves.toBeUndefined()
  })
})

describe('formatSummary', () => {
  it('formats entries with checkmarks', () => {
    const s = formatSummary([
      { name: 'a', result: 'success', time: '20260801T100000', output: '', filename: 'a.log' },
      { name: 'b', result: 'failure', time: '20260801T093000', output: 'err', filename: 'b.log' },
    ])
    expect(s).toContain('a')
    expect(s).toContain('✓')
    expect(s).toContain('b')
    expect(s).toContain('✗')
  })
})
