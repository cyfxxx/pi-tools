import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-seeds-'))
process.env.PI_DAILY_RESULTS_DIR = join(TEST_DIR, 'daily-results')

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { loadSeeds, syncSeedTasks, __resetSeedCache } = await import('../seeds')
const { readTasks } = await import('../storage')

const SEEDS = {
  version: 1,
  tasks: [
    {
      name: 'seed-a',
      type: 'cron',
      schedule: '0 8 * * *',
      prompt: 'run a',
      useSubagent: true,
      notifyMain: true,
      maxRunTime: 300,
      tags: ['daily'],
    },
    {
      name: 'seed-b',
      type: 'interval',
      schedule: '1h',
      prompt: 'run b',
    },
  ],
}

beforeEach(async () => {
  __resetSeedCache()
  // 清残留：任务存储与种子文件都可能被上一用例写入
  await rm(join(TEST_DIR, 'scheduled-tasks.json'), { force: true })
  await rm(join(TEST_DIR, 'scheduled-seeds.json'), { force: true })
})

describe('loadSeeds', () => {
  it('reads seed tasks from agent dir', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    const seeds = await loadSeeds()
    expect(seeds.length).toBe(2)
    expect(seeds[0].name).toBe('seed-a')
    expect(seeds[0].type).toBe('cron')
  })

  it('returns [] when file missing', async () => {
    expect(await loadSeeds()).toEqual([])
  })

  it('filters malformed entries', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify({
      tasks: [{ name: 'bad', type: 'nope', schedule: '', prompt: '' }, { name: 'ok', type: 'once', schedule: '+1h', prompt: 'x' }],
    }), 'utf8')
    const seeds = await loadSeeds()
    expect(seeds.length).toBe(1)
    expect(seeds[0].name).toBe('ok')
  })
})

describe('syncSeedTasks', () => {
  it('registers missing seed tasks once (幂等)', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    const first = await syncSeedTasks()
    expect(first).toBe(2)
    const second = await syncSeedTasks()
    expect(second).toBe(0)
    const store = await readTasks()
    expect(store.tasks.filter(t => t.name === 'seed-a' || t.name === 'seed-b').length).toBe(2)
  })

  it('does not overwrite existing local task with same name', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    // 先手工注册同名的本地自定义任务（prompt 不同）
    const { addTask } = await import('../storage')
    await addTask({ name: 'seed-a', type: 'cron', schedule: '0 9 * * *', prompt: 'custom local prompt' })
    const added = await syncSeedTasks()
    expect(added).toBe(1) // 只补 seed-b
    const store = await readTasks()
    const a = store.tasks.find(t => t.name === 'seed-a')
    expect(a!.prompt).toBe('custom local prompt')
    expect(a!.schedule).toBe('0 9 * * *')
  })

  it('accepts precomputed existing names to skip re-read', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    // 模拟既有任务名来自外部（tick 已读 store 场景）
    const added = await syncSeedTasks(new Set(['seed-a', 'unknown-local']))
    expect(added).toBe(1)
    const store = await readTasks()
    expect(store.tasks.some(t => t.name === 'seed-b')).toBe(true)
  })

  it('no-op without seeds file', async () => {
    expect(await syncSeedTasks()).toBe(0)
  })
})