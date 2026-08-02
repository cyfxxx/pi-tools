import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-budget-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { checkBudget, formatBudgetUsage } = await import('../budget')
const { appendRun } = await import('../telemetry')

describe('checkBudget', () => {
  it('allows when under limits', async () => {
    const res = await checkBudget({ maxRunsPerDay: 50, maxCostPerDay: 0 }, 'model-x')
    expect(res.allowed).toBe(true)
  })

  it('blocks when maxRunsPerDay exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await appendRun({
        ts: new Date().toISOString(), taskId: 't', taskName: 't',
        model: 'm', provider: 'p', result: 'success', durationMs: 1, outputLen: 1, estCost: 0, errClass: null,
      })
    }
    const res = await checkBudget({ maxRunsPerDay: 3 }, 'm')
    expect(res.allowed).toBe(false)
    expect(res.reason).toContain('3/3')
  })

  it('blocks when maxCostPerDay exceeded', async () => {
    await rm(join(TEST_DIR, '.pi-autopilot-telemetry.json'), { force: true })
    await appendRun({
      ts: new Date().toISOString(), taskId: 't', taskName: 't',
      model: 'm', provider: 'p', result: 'success', durationMs: 1, outputLen: 1, estCost: 0.006, errClass: null,
    })
    const res = await checkBudget({ maxCostPerDay: 0.005 }, 'm')
    expect(res.allowed).toBe(false)
    expect(res.reason).toContain('成本')
  })

  it('blocks model not in allowedModels', async () => {
    const res = await checkBudget({ allowedModels: ['allowed-a'] }, 'model-x')
    expect(res.allowed).toBe(false)
    const ok = await checkBudget({ allowedModels: ['allowed-a'] }, 'allowed-a')
    expect(ok.allowed).toBe(true)
  })
})

describe('formatBudgetUsage', () => {
  it('summarizes today usage', () => {
    const s = formatBudgetUsage([{
      ts: new Date().toISOString(), taskId: 't', taskName: 't',
      model: 'm', provider: 'p', result: 'success', durationMs: 1, outputLen: 1, estCost: 0.0012, errClass: null,
    }])
    expect(s).toContain('1 次')
    expect(s).toContain('$0.0012')
  })
})
