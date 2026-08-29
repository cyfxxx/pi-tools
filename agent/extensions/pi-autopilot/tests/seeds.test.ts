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

const { loadSeeds, syncSeedTasks, diffSeedTask, __resetSeedCache, __resetDriftSig } = await import('../seeds')
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
  __resetDriftSig()
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
    expect(first.added).toBe(2)
    expect(first.drifted).toEqual([])
    const second = await syncSeedTasks()
    expect(second.added).toBe(0)
    const store = await readTasks()
    expect(store.tasks.filter(t => t.name === 'seed-a' || t.name === 'seed-b').length).toBe(2)
  })

  it('does not overwrite existing local task with same name', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    // 先手工注册同名的本地自定义任务（prompt 不同）
    const { addTask } = await import('../storage')
    await addTask({ name: 'seed-a', type: 'cron', schedule: '0 9 * * *', prompt: 'custom local prompt' })
    const r = await syncSeedTasks()
    expect(r.added).toBe(1) // 只补 seed-b
    expect(r.drifted).toEqual(['seed-a(schedule 0 9 * * *≠0 8 * * *+prompt)'])
    const store = await readTasks()
    const a = store.tasks.find(t => t.name === 'seed-a')
    expect(a!.prompt).toBe('custom local prompt')
    expect(a!.schedule).toBe('0 9 * * *')
  })

  it('accepts precomputed existing names to skip re-read', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    // 模拟既有任务名来自外部（Set 分支：仅补缺失，无任务对象时不做漂移比对）
    const r = await syncSeedTasks(new Set(['seed-a', 'unknown-local']))
    expect(r.added).toBe(1)
    const store = await readTasks()
    expect(store.tasks.some(t => t.name === 'seed-b')).toBe(true)
  })

  it('no-op without seeds file', async () => {
    expect(await syncSeedTasks()).toEqual({ added: 0, drifted: [] })
  })

  it('accepts precomputed task objects and detects drift (tick 路径)', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    const local = [{ id: 'x', name: 'seed-a', type: 'cron' as const, schedule: '0 8 * * *', prompt: 'stale local prompt', enabled: true }] as never[]
    const r = await syncSeedTasks(local)
    expect(r.added).toBe(1) // seed-b 缺失被补
    expect(r.drifted).toEqual(['seed-a(prompt)'])
  })
})

describe('diffSeedTask 纯函数', () => {
  const seed = { name: 'x', type: 'cron' as const, schedule: '0 8 * * *', prompt: 'p' }
  it('一致返回 null', () => {
    expect(diffSeedTask({ type: 'cron', schedule: '0 8 * * *', prompt: 'p' }, seed)).toBeNull()
  })
  it('分别识别 schedule/prompt/type 差异并组合', () => {
    expect(diffSeedTask({ type: 'cron', schedule: '0 9 * * *', prompt: 'p' }, seed)).toBe('schedule 0 9 * * *≠0 8 * * *')
    expect(diffSeedTask({ type: 'cron', schedule: '0 8 * * *', prompt: 'q' }, seed)).toBe('prompt')
    expect(diffSeedTask({ type: 'interval', schedule: '0 9 * * *', prompt: 'q' }, seed)).toBe('type interval≠cron+schedule 0 9 * * *≠0 8 * * *+prompt')
  })
})

describe('漂移日志（签名去重 + 消除闭合）', () => {
  const DRIFT_LOG = join(TEST_DIR, '..', 'logs', 'scheduler', 'seed-drift.log')

  it('同签名重复对账不重复追加，漂移消除后写闭合行', async () => {
    await rm(DRIFT_LOG, { force: true }) // 清历史（模块级签名跨用例残留）
    await writeFile(join(TEST_DIR, 'scheduled-seeds.json'), JSON.stringify(SEEDS), 'utf8')
    const { addTask, readTasks, writeTasks } = await import('../storage')
    await addTask({ name: 'seed-a', type: 'cron', schedule: '0 8 * * *', prompt: 'custom local prompt' })
    await syncSeedTasks() // 首次发现漂移 → 写入一行
    await syncSeedTasks() // 同签名 → 不追加
    const lines = (await readFile(DRIFT_LOG, 'utf8')).trim().split('\n')
    expect(lines.filter(l => l.includes('漂移:')).length).toBe(1)
    // 修复漂移（本地对齐 seeds）→ 再对账 → 消除闭合行
    const store = await readTasks()
    const a = store.tasks.find(t => t.name === 'seed-a')!
    a.prompt = 'run a'
    await writeTasks(store)
    const r = await syncSeedTasks()
    expect(r.drifted).toEqual([])
    const after = (await readFile(DRIFT_LOG, 'utf8')).trim().split('\n')
    expect(after.some(l => l.includes('漂移已消除'))).toBe(true)
  })
})