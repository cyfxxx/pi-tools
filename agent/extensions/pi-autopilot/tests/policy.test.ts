import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-policy-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

// 写 settings.json 供 currentModel 读取
await writeFile(join(TEST_DIR, 'settings.json'), JSON.stringify({
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-v4-flash',
}), 'utf-8')

const { decide, classifyError, currentModel } = await import('../policy')

const defaultPolicy = { failoverAfter: 2, suspendAfter: 5, timeoutFactor: 2 }
const chain = [
  { provider: 'deepseek', model: 'deepseek-v3' },
  { provider: 'local-llama', model: 'qwen-7b' },
]

function makeTask(overrides: Partial<{ failCount: number; retries: number }> = {}) {
  return {
    id: 't1', name: 'task', type: 'interval', schedule: '5m', prompt: 'p',
    enabled: true, lastRun: null, lastResult: null, lastOutput: '', nextRun: null,
    useSubagent: true, notifyOnCompletion: false, maxRunTime: 300, runCount: 0,
    history: [], tags: [], retries: 0, failCount: 0, pendingInject: false,
    createdAt: '', updatedAt: '',
    ...overrides,
  } as Parameters<typeof decide>[0]
}

const info = { stderr: '', exitCode: 1, promptLen: 10, outputLen: 20, durationMs: 5000 }

describe('classifyError', () => {
  it('classifies timeout (exit 124)', () => {
    expect(classifyError('', 124)).toBe('timeout')
  })

  it('classifies provider errors', () => {
    expect(classifyError('connection refused', 1)).toBe('provider_down')
    expect(classifyError('ECONNRESET to api.deepseek.com', 1)).toBe('provider_down')
    expect(classifyError('429 rate limit', 1)).toBe('provider_down')
    expect(classifyError('timeout after 30s', 1)).toBe('provider_down')
  })

  it('classifies logic errors', () => {
    expect(classifyError('Error: invalid argument', 1)).toBe('logic_error')
  })
})

describe('decide', () => {
  it('logic error fails without failover', () => {
    const action = decide(makeTask({ failCount: 10 }), 'logic_error', defaultPolicy, chain, info)
    expect(action.type).toBe('fail')
  })

  it('timeout with retries remaining retries', () => {
    const action = decide(makeTask({ retries: 2, failCount: 1 }), 'timeout', defaultPolicy, chain, info)
    expect(action.type).toBe('retry')
  })

  it('timeout with retries exhausted fails over', () => {
    const action = decide(makeTask({ retries: 2, failCount: 2 }), 'timeout', defaultPolicy, chain, info)
    expect(action.type).toBe('failover')
    expect(action.type === 'failover' && action.target).toEqual(chain[0])
  })

  it('provider down below threshold with no retries fails', () => {
    const action = decide(makeTask({ failCount: 1 }), 'provider_down', defaultPolicy, chain, info)
    expect(action.type).toBe('fail')
  })

  it('provider down at threshold fails over', () => {
    const action = decide(makeTask({ failCount: 2 }), 'provider_down', defaultPolicy, chain, info)
    expect(action.type).toBe('failover')
  })

  it('provider down without fallback chain fails with hint', () => {
    const action = decide(makeTask({ failCount: 3 }), 'provider_down', defaultPolicy, [], info)
    expect(action.type).toBe('fail')
    expect(action.type === 'fail' && action.note).toContain('fallbackModels')
  })

  it('suspends after suspendAfter consecutive unknown failures', () => {
    const action = decide(makeTask({ failCount: 5 }), 'unknown', defaultPolicy, [], info)
    expect(action.type).toBe('suspend_task')
  })
})

describe('currentModel', () => {
  it('reads model from settings', () => {
    expect(currentModel()).toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })
})
