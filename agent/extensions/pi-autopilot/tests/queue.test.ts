import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-queue-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const base = {
  id: '', name: '任务', type: 'interval' as const, schedule: '5m', prompt: 'p',
  enabled: true, lastRun: null, lastResult: null, lastOutput: '', nextRun: null,
  useSubagent: true, notifyOnCompletion: false, maxRunTime: 300, runCount: 0,
  history: [], tags: [], retries: 0, failCount: 0, pendingInject: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

describe('pendingInject marking', () => {
  beforeEach(async () => {
    await rm(join(TEST_DIR, 'scheduled-tasks.json'), { force: true })
    await rm(join(TEST_DIR, '.pi-autopilot-crash.json'), { force: true })
  })

  it('marks a task as pending and collects it', async () => {
    const { addTask } = await import('../storage')
    const { markPendingInjected, clearPending, collectPendingTasks } = await import('../queue')
    const task = await addTask({ name: '注入任务', type: 'interval', schedule: '5m', prompt: '写报告' })
    await markPendingInjected(task.id)

    const pending = await collectPendingTasks()
    expect(pending).toHaveLength(1)
    expect(pending[0].prompt).toBe('写报告')

    await clearPending(pending[0].id)
    expect(await collectPendingTasks()).toHaveLength(0)
  })

  it('detects abnormal shutdown via crash file', async () => {
    const { wasAbnormalShutdown } = await import('../queue')
    expect(await wasAbnormalShutdown()).toBe(false)
    await writeFile(join(TEST_DIR, '.pi-autopilot-crash.json'), JSON.stringify({ count: 1, ts: new Date().toISOString() }))
    expect(await wasAbnormalShutdown()).toBe(true)
  })
})
