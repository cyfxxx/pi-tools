import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-failover-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)
// 双层隔离：即使 vitest 别名失效（agent 根直跑），状态写入也重定向到临时目录
process.env.PI_ADMIN_STATE_FILE = join(TEST_DIR, '.pi-admin-state.json')

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const chain = [
  { provider: 'deepseek', model: 'deepseek-v3' },
  { provider: 'local-llama', model: 'qwen-7b' },
]

describe('selectFailover', () => {
  it('skips current model', async () => {
    const { selectFailover } = await import('../failover')
    const target = await selectFailover(chain, 'deepseek', 'deepseek-v3')
    expect(target).toEqual(chain[1])
  })

  it('prefers same provider when no telemetry', async () => {
    const { selectFailover } = await import('../failover')
    const target = await selectFailover(chain, 'deepseek', 'deepseek-v4-flash')
    expect(target).toEqual(chain[0])
  })

  it('prefers higher success rate with telemetry', async () => {
    const { selectFailover } = await import('../failover')
    const { appendRun } = await import('../telemetry')
    // local-llama 成功率更高
    for (let i = 0; i < 5; i++) {
      await appendRun({
        ts: new Date().toISOString(), taskId: 'a', taskName: 'a',
        model: 'qwen-7b', provider: 'local-llama', result: 'success',
        durationMs: 100, outputLen: 10, estCost: 0, errClass: null,
      })
    }
    await appendRun({
      ts: new Date().toISOString(), taskId: 'b', taskName: 'b',
      model: 'deepseek-v3', provider: 'deepseek', result: 'failed',
      durationMs: 100, outputLen: 10, estCost: 0, errClass: 'provider_down',
    })
    const target = await selectFailover(chain, 'deepseek', 'deepseek-v4-flash')
    expect(target).toEqual(chain[1])
    await rm(join(TEST_DIR, '.pi-autopilot-telemetry.json'), { force: true })
  })

  it('returns null when chain is empty', async () => {
    const { selectFailover } = await import('../failover')
    expect(await selectFailover([], 'a', 'b')).toBeNull()
  })
})

describe('planFailover / executeFailover', () => {
  beforeEach(async () => {
    await rm(join(TEST_DIR, '.pi-admin-state.json'), { force: true })
  })

  it('plans failover with reason', async () => {
    const { planFailover } = await import('../failover')
    const plan = await planFailover(chain, 'deepseek', 'deepseek-v4-flash')
    expect(plan.target).toBeTruthy()
    expect(plan.reason).toContain('→')
  })

  it('dry-run does not write state', async () => {
    const { executeFailover } = await import('../failover')
    const msg = await executeFailover(chain[0], 'test', true)
    expect(msg).toContain('[dry-run]')
    const { readFile } = await import('fs/promises')
    await expect(readFile(join(TEST_DIR, '.pi-admin-state.json'))).rejects.toThrow()
  })

  it('exec writes restart state with target model', async () => {
    const { executeFailover } = await import('../failover')
    const msg = await executeFailover(chain[1], 'fallback', false)
    expect(msg).toContain('正在切换模型')
    const { readFile } = await import('fs/promises')
    const state = JSON.parse(await readFile(join(TEST_DIR, '.pi-admin-state.json'), 'utf-8'))
    expect(state.action).toBe('set_model')
    expect(state.targetModel).toBe('qwen-7b')
    expect(state.targetProvider).toBe('local-llama')
  })
})
