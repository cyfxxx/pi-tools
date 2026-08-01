import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let TEST_DIR = ''
let LOG_DIR = ''

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')

beforeAll(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-scheduler-notif-'))
  __setAgentDir(TEST_DIR)
  LOG_DIR = join(TEST_DIR, '..', 'logs', 'scheduler')
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
