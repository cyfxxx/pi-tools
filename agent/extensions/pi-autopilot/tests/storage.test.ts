import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-scheduler-test-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

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
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(0)
    expect([1, 2, 3, 4, 5]).toContain(d.getDay())
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

  it('updateTask rejects invalid schedule on recalc', async () => {
    const task = await addTask({ name: 'recalc', type: 'interval', schedule: '5m', prompt: 'p' })
    await expect(updateTask(task.id, { schedule: 'garbage' })).rejects.toThrow('无效调度表达式')
    const t = await updateTask(task.id, { schedule: '10m' })
    expect(t?.schedule).toBe('10m')
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

describe('migration (v1 → v3)', () => {
  it('fills default fields for legacy tasks', async () => {
    const { readTasks } = await import('../storage')
    const p = join(TEST_DIR, 'scheduled-tasks.json')
    const { writeFile } = await import('fs/promises')
    await writeFile(p, JSON.stringify({
      version: 1,
      settings: {},
      tasks: [{ id: 'old', name: 'legacy', type: 'interval', schedule: '5m', prompt: 'p', enabled: true, lastRun: null, lastResult: null, lastOutput: '', nextRun: '2026-09-01T00:00:00Z' }],
    }))
    const store = await readTasks()
    expect(store.version).toBe(3)
    const t = store.tasks[0]
    expect(t.history).toEqual([])
    expect(t.tags).toEqual([])
    expect(t.retries).toBe(0)
    expect(t.failCount).toBe(0)
    expect(t.pendingInject).toBe(false)
    expect(t.maxRunTime).toBe(300)
    await rm(join(TEST_DIR, 'scheduled-tasks.json'), { force: true })
  })
})

describe('addTask validation', () => {
  beforeEach(async () => {
    const { writeTasks, readTasks } = await import('../storage')
    await writeTasks(await readTasks())
  })

  it('rejects duplicate names', async () => {
    await addTask({ name: 'dup', type: 'interval', schedule: '5m', prompt: 'p' })
    await expect(addTask({ name: 'dup', type: 'interval', schedule: '5m', prompt: 'p' })).rejects.toThrow('已存在同名任务')
  })

  it('rejects invalid schedule expressions', async () => {
    await expect(addTask({ name: 'bad', type: 'interval', schedule: 'garbage', prompt: 'p' })).rejects.toThrow('无效调度表达式')
    await expect(addTask({ name: 'bad2', type: 'cron', schedule: '99 99 * * *', prompt: 'p' })).rejects.toThrow('无效调度表达式')
    await expect(addTask({ name: 'bad3', type: 'once', schedule: 'not-a-time', prompt: 'p' })).rejects.toThrow('无效调度表达式')
  })

  it('stores tags and retries', async () => {
    const task = await addTask({ name: 'tagged', type: 'interval', schedule: '5m', prompt: 'p', tags: ['ci', 'daily'], retries: 3 })
    expect(task.tags).toEqual(['ci', 'daily'])
    expect(task.retries).toBe(3)
    expect(task.history).toEqual([])
  })
})

describe('updateTaskAfterRun v2 behavior', () => {
  it('pushes history with duration and truncates at 10', async () => {
    const task = await addTask({ name: 'hist', type: 'interval', schedule: '5m', prompt: 'p' })
    for (let i = 0; i < 12; i++) {
      await updateTaskAfterRun(task.id, i % 2 === 0 ? 'success' : 'failed', `output-${i}`, 1000 + i)
    }
    const { readTasks } = await import('../storage')
    const t = (await readTasks()).tasks.find(x => x.id === task.id)!
    expect(t.history).toHaveLength(10)
    expect(t.history[9].result).toBe('failed')
    expect(t.history[9].durationMs).toBe(1011)
    expect(t.history[0].output).toBe('output-2')
  })

  it('removes once tasks after success', async () => {
    const task = await addTask({ name: 'one-off', type: 'once', schedule: '+30m', prompt: 'p' })
    await updateTaskAfterRun(task.id, 'success', 'done')
    const { readTasks } = await import('../storage')
    const store = await readTasks()
    expect(store.tasks.some(x => x.id === task.id)).toBe(false)
  })

  it('schedules retry on failure when retries remain', async () => {
    const task = await addTask({ name: 'flaky', type: 'interval', schedule: '5m', prompt: 'p', retries: 2 })
    await updateTaskAfterRun(task.id, 'failed', 'boom')
    const { readTasks } = await import('../storage')
    let t = (await readTasks()).tasks.find(x => x.id === task.id)!
    expect(t.failCount).toBe(1)
    expect(t.runCount).toBe(0)
    // A1 指数退避：failCount=1 → 30s ± 50% 抖动（[15s, 45s]）
    const gap = new Date(t.nextRun!).getTime() - Date.now()
    expect(gap).toBeGreaterThan(14000)
    expect(gap).toBeLessThan(46000)
    await updateTaskAfterRun(task.id, 'failed', 'boom2')
    t = (await readTasks()).tasks.find(x => x.id === task.id)!
    expect(t.failCount).toBe(2)
    await updateTaskAfterRun(task.id, 'failed', 'boom3')
    t = (await readTasks()).tasks.find(x => x.id === task.id)!
    expect(t.failCount).toBe(3)
    expect(t.runCount).toBe(1)
    // 重试耗尽：回到正常调度（interval 5m = 300s > 280s 下限保持）
    const nextGap = new Date(t.nextRun!).getTime() - Date.now()
    expect(nextGap).toBeGreaterThan(280000)
  })

  it('resets failCount on success', async () => {
    const task = await addTask({ name: 'recover', type: 'interval', schedule: '5m', prompt: 'p', retries: 2 })
    await updateTaskAfterRun(task.id, 'failed', 'boom')
    await updateTaskAfterRun(task.id, 'success', 'ok')
    const { readTasks } = await import('../storage')
    const t = (await readTasks()).tasks.find(x => x.id === task.id)!
    expect(t.failCount).toBe(0)
    expect(t.runCount).toBe(1)
  })
})

describe('renderPrompt', () => {
  it('replaces template variables', async () => {
    const { renderPrompt } = await import('../storage')
    const out = renderPrompt('today is {{date}} at {{time}}, cwd={{cwd}}')
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(out).toContain(`today is ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    expect(out).toContain('cwd=')
    expect(out).not.toContain('{{date}}')
  })
})

describe('previewCron', () => {
  it('returns increasing future trigger times', async () => {
    const { previewCron } = await import('../storage')
    const times = await previewCron('0 9 * * 1-5')
    expect(times).toHaveLength(5)
    const t = times.map(x => new Date(x).getTime())
    expect(t[1]).toBeGreaterThan(t[0])
    expect(t[4]).toBeGreaterThan(t[3])
  })

  it('rejects invalid expressions', async () => {
    const { previewCron } = await import('../storage')
    await expect(previewCron('garbage')).rejects.toThrow('无效 cron 表达式')
  })
})

describe('export / import', () => {
  beforeEach(async () => {
    const { writeTasks, readTasks } = await import('../storage')
    const store = await readTasks()
    store.tasks = []
    await writeTasks(store)
  })

  it('round-trips tasks and skips duplicates/invalid', async () => {
    const { exportTasks, importTasks, readTasks } = await import('../storage')
    await addTask({ name: 'keep', type: 'interval', schedule: '5m', prompt: 'p', tags: ['a'], retries: 1 })
    await addTask({ name: 'dup-name', type: 'once', schedule: '+1h', prompt: 'p' })
    const outPath = await exportTasks()
    const { readFile } = await import('fs/promises')
    const exported = JSON.parse(await readFile(outPath, 'utf-8'))
    expect(exported.tasks).toHaveLength(2)
    await rm(join(TEST_DIR, 'scheduled-tasks.json'), { force: true })
    const res = await importTasks(outPath)
    expect(res.imported).toBe(2)
    expect(res.skipped).toEqual([])
    const res2 = await importTasks(outPath)
    expect(res2.imported).toBe(0)
    expect(res2.skipped.sort()).toEqual(['dup-name', 'keep'])
    await rm(outPath, { force: true })
  })
})

describe('settings', () => {
  it('get/set round-trip', async () => {
    const { getSettings, setSettings } = await import('../storage')
    await setSettings({ paused: true, webhookUrl: 'https://example.com/hook' })
    const s = await getSettings()
    expect(s.paused).toBe(true)
    expect(s.webhookUrl).toBe('https://example.com/hook')
    await setSettings({ paused: false })
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
    history: [],
    tags: [],
    retries: 0,
    failCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
