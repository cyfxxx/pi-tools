import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-telemetry-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

// 写 models.json 供 estimateCost
await writeFile(join(TEST_DIR, 'models.json'), JSON.stringify({
  providers: {
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      api: 'openai',
      models: [{ id: 'deepseek-v4-flash', pricePer1kIn: 0.0001, pricePer1kOut: 0.0004 }],
    },
  },
}), 'utf-8')

const { appendRun, readTelemetry, statsByModel, statsByTask, todayRuns, todayCost, estimateCost, errClassOf } = await import('../telemetry')

function run(overrides: Partial<Parameters<typeof appendRun>[0]> = {}) {
  return appendRun({
    ts: new Date().toISOString(), taskId: 't1', taskName: '日报',
    model: 'deepseek-v4-flash', provider: 'deepseek', result: 'success',
    durationMs: 5000, outputLen: 1000, estCost: 0.0004, errClass: null,
    ...overrides,
  })
}

describe('appendRun / readTelemetry', () => {
  it('appends and enforces limit', async () => {
    for (let i = 0; i < 15; i++) await run()
    const all = await readTelemetry()
    expect(all.length).toBe(15)
  })

  it('statsByModel aggregates success/fail', async () => {
    await run({ result: 'failed', errClass: 'timeout' })
    const stats = statsByModel(await readTelemetry())
    expect(stats[0].successRate).toBeCloseTo(15 / 16, 6)
    expect(stats[0].failures).toBe(1)
  })

  it('statsByTask aggregates duration and cost', async () => {
    const stats = statsByTask(await readTelemetry())
    expect(stats[0].runs).toBe(16)
  })

  it('todayRuns / todayCost', async () => {
    const runs = await readTelemetry()
    expect(todayRuns(runs)).toBe(16)
    expect(todayCost(runs)).toBeCloseTo(16 * 0.0004, 6)
  })
})

describe('estimateCost', () => {
  it('reads prices from models.json', async () => {
    const cost = estimateCost('deepseek', 'deepseek-v4-flash', 1000, 500)
    expect(cost).toBeCloseTo(0.0001 + 0.0002, 6)
  })

  it('returns 0 for unknown model', async () => {
    expect(estimateCost('x', 'y', 1000, 1000)).toBe(0)
  })
})

describe('errClassOf', () => {
  it('maps stderr/exitCode to class', () => {
    expect(errClassOf('connection refused', 1)).toBe('provider_down')
    expect(errClassOf('Error: some logic failure', 1)).toBe('logic_error')
    expect(errClassOf('', 2)).toBe('unknown')
  })
})
