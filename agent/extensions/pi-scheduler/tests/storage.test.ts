import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

let TEST_DIR = ''

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')

beforeAll(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-scheduler-test-'))
  __setAgentDir(TEST_DIR)
})

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { parseIntervalToMs, parseRelativeTime, formatInterval, computeNextRun, isDue, addTask, listTasks, updateTask, deleteTask, updateTaskAfterRun, acquireSessionLock, releaseSessionLock } = await import('../storage')
const { readTasks } = await import('../storage')

describe('parseIntervalToMs', () => {
  it('parses standard units', () => {
    expect(parseIntervalToMs('30s')).toBe(30000)
    expect(parseIntervalToMs('5m')).toBe(300000)
    expect(parseIntervalToMs('1h')).toBe(3600000)
    expect(parseIntervalToMs('2d')).toBe(172800000)
  })

  it('parses long-form units', () => {
    expect(parseIntervalToMs('10min')).toBe(600000)
    expect(parseIntervalToMs('3hr')).toBe(10800000)
    expect(parseIntervalToMs('1sec')).toBe(1000)
    expect(parseIntervalToMs('1day')).toBe(86400000)
  })

  it('rejects invalid input', () => {
    expect(parseIntervalToMs('abc')).toBeNull()
    expect(parseIntervalToMs('')).toBeNull()
    expect(parseIntervalToMs('5')).toBeNull()
  })
})

describe('parseRelativeTime', () => {
  it('parses relative times', () => {
    expect(parseRelativeTime('+30m')).toBe(1800000)
    expect(parseRelativeTime('+5s')).toBe(5000)
    expect(parseRelativeTime('+1h')).toBe(3600000)
    expect(parseRelativeTime('+2d')).toBe(172800000)
  })

  it('defaults to minutes when unit omitted', () => {
    expect(parseRelativeTime('+10')).toBe(600000)
  })

  it('rejects non-relative input', () => {
    expect(parseRelativeTime('30m')).toBeNull()
  })
})

describe('formatInterval', () => {
  it('formats ms to human units', () => {
    expect(formatInterval(30000)).toBe('30s')
    expect(formatInterval(300000)).toBe('5m')
    expect(formatInterval(3600000)).toBe('1h')
    expect(formatInterval(86400000)).toBe('1d')
  })
})

describe('computeNextRun', () => {
  const base: Parameters<typeof addTask>[0] = {
    name: 'test',
    type: 'interval',
    schedule: '5m',
    prompt: 'run test',
  }

  it('interval task without lastRun starts from now', () => {
    const next = computeNextRun({ ...createTaskShape(base), nextRun: null } as any)
    if (!next) throw new Error('nextRun is null')
    const delta = new Date(next).getTime() - Date.now()
    expect(delta).toBeGreaterThan(290000)
    expect(delta).toBeLessThan(310000)
  })

  it('interval task with lastRun anchors from lastRun', () => {
    const last = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const next = computeNextRun({ ...createTaskShape(base), lastRun: last } as any)!
    const delta = new Date(next).getTime() - new Date(last).getTime()
    expect(delta).toBe(300000)
  })

  it('once task with relative schedule', () => {
    const next = computeNextRun({ ...createTaskShape({ ...base, type: 'once', schedule: '+30m' }), lastRun: null } as any)!
    const delta = new Date(next).getTime() - Date.now()
    expect(delta).toBeGreaterThan(1700000)
    expect(delta).toBeLessThan(1900000)
  })

  it('once task with absolute ISO schedule', () => {
    const abs = '2026-08-02T10:00:00.000Z'
    const next = computeNextRun({ ...createTaskShape({ ...base, type: 'once', schedule: abs }), lastRun: null } as any)!
    expect(new Date(next).toISOString()).toBe(abs)
  })

  it('once task returns null after already run', () => {
    const next = computeNextRun({ ...createTaskShape({ ...base, type: 'once', schedule: '+30m' }), lastRun: new Date().toISOString() } as any)
    expect(next).toBeNull()
  })

  it('cron task computes next 9am weekday', () => {
    const next = computeNextRun({ ...createTaskShape({ ...base, type: 'cron', schedule: '0 9 * * 1-5' }) } as any)!
    const d = new Date(next)
    expect(d.getUTCHours()).toBe(9)
    expect(d.getUTCMinutes()).toBe(0)
    expect([1, 2, 3, 4, 5]).toContain(d.getUTCDay())
    expect(d.getTime()).toBeGreaterThan(Date.now())
  })

  it('returns null for invalid schedule', () => {
    expect(computeNextRun({ ...createTaskShape(base), schedule: 'garbage' } as any)).toBeNull()
  })
})

describe('isDue', () => {
  it('disabled task is never due', () => {
    expect(isDue({ enabled: false, nextRun: new Date(Date.now() - 1000).toISOString() } as any)).toBe(false)
  })

  it('task without nextRun is never due', () => {
    expect(isDue({ enabled: true, nextRun: null } as any)).toBe(false)
  })

  it('past nextRun is due', () => {
    expect(isDue({ enabled: true, nextRun: new Date(Date.now() - 1000).toISOString() } as any)).toBe(true)
  })

  it('future nextRun is not due', () => {
    expect(isDue({ enabled: true, nextRun: new Date(Date.now() + 10000).toISOString() } as any)).toBe(false)
  })
})

describe('task CRUD (isolated store)', () => {
  beforeEach(async () => {
    const { writeTasks, readTasks } = await import('../storage')
    const store = await readTasks()
    store.tasks = []
    await writeTasks(store)
  })

  it('adds a task with computed nextRun', async () => {
    const task = await addTask({ name: 't1', type: 'interval', schedule: '5m', prompt: 'p1' })
    expect(task.name).toBe('t1')
    expect(task.nextRun).toBeTruthy()
    expect(task.maxRunTime).toBe(300)
  })

  it('adds a task with custom maxRunTime', async () => {
    const task = await addTask({ name: 't2', type: 'once', schedule: '+30m', prompt: 'p2', maxRunTime: 600 })
    expect(task.maxRunTime).toBe(600)
  })

  it('lists tasks sorted by nextRun', async () => {
    await addTask({ name: 'late', type: 'interval', schedule: '2h', prompt: 'p' })
    await addTask({ name: 'early', type: 'interval', schedule: '30s', prompt: 'p' })
    const tasks = await listTasks()
    expect(tasks[0].name).toBe('early')
    expect(tasks[1].name).toBe('late')
  })

  it('updates task by id and name', async () => {
    const task = await addTask({ name: 'upd', type: 'interval', schedule: '5m', prompt: 'p' })
    const byId = await updateTask(task.id, { enabled: false })
    expect(byId?.enabled).toBe(false)
    const byName = await updateTask('upd', { schedule: '10m' })
    expect(byName?.enabled).toBe(false)
    expect(byName?.schedule).toBe('10m')
    expect(byName?.nextRun).toBeTruthy()
  })

  it('updateTask returns null for missing task', async () => {
    expect(await updateTask('nope', { enabled: true })).toBeNull()
  })

  it('updateTaskAfterRun records result and recomputes nextRun', async () => {
    const task = await addTask({ name: 'run', type: 'interval', schedule: '5m', prompt: 'p' })
    await updateTaskAfterRun(task.id, 'success', 'output '.repeat(300))
    const store = await readTasks()
    const t = store.tasks.find(x => x.id === task.id)!
    expect(t.lastResult).toBe('success')
    expect(t.runCount).toBe(1)
    expect(t.lastOutput.length).toBeLessThanOrEqual(1000)
    const delta = new Date(t.nextRun!).getTime() - new Date(t.lastRun!).getTime()
    expect(delta).toBe(300000)
  })

  it('deletes task by name', async () => {
    await addTask({ name: 'del', type: 'once', schedule: '+1h', prompt: 'p' })
    expect(await deleteTask('del')).toBe(true)
    expect(await deleteTask('del')).toBe(false)
  })

  it('writeTasks is atomic (tmp+rename)', async () => {
    const { tasksPath, writeTasks } = await import('../storage')
    await writeTasks({ version: 1, settings: {}, tasks: [] })
    const p = tasksPath()
    const tmpFiles = (await readFile(p, 'utf-8')).length > 0
    expect(tmpFiles).toBe(true)
    const dir = join(TEST_DIR)
    const leftover = (await import('fs/promises')).readdir(dir)
    expect((await leftover).filter(f => f.includes('.tmp')).length).toBe(0)
  })
})

describe('session lock', () => {
  it('acquires and releases lock', async () => {
    expect(await acquireSessionLock()).toBe(true)
    expect(await releaseSessionLock()).toBeUndefined()
    expect(await acquireSessionLock()).toBe(true)
    await releaseSessionLock()
  })
})

function createTaskShape(p: Parameters<typeof addTask>[0]): Record<string, unknown> {
  return {
    id: 'test-id',
    name: p.name,
    type: p.type,
    schedule: p.schedule,
    prompt: p.prompt,
    enabled: true,
    lastRun: null,
    lastResult: null,
    lastOutput: '',
    nextRun: null,
    useSubagent: false,
    notifyOnCompletion: false,
    maxRunTime: 300,
    runCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
