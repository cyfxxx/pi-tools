import { describe, it, expect, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-scheduler-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    name: 'test-task',
    type: 'interval',
    schedule: '5m',
    prompt: 'do something',
    enabled: true,
    useSubagent: false,
    notifyOnCompletion: false,
    nextRun: new Date(Date.now() - 60000).toISOString(), // 已到期
    lastRun: null,
    lastResult: null,
    lastOutput: '',
    failCount: 0,
    runCount: 0,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveryCount: 0,
    retries: 0,
    pendingInject: false,
    maxRunTime: 300,
    ...overrides,
  }
}

async function writeTasksFile(tasks: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(TEST_DIR, 'scheduled-tasks.json'), JSON.stringify({ version: 3, settings: {}, tasks }), 'utf-8')
}

async function readTasksFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(TEST_DIR, 'scheduled-tasks.json'), 'utf-8'))
}

async function fillTelemetry(n: number): Promise<void> {
  const runs = Array.from({ length: n }, () => ({
    ts: new Date().toISOString(),
    taskId: 'x', taskName: 'x', model: 'm', provider: 'p',
    result: 'success', durationMs: 1, outputLen: 1, estCost: 0, errClass: null,
  }))
  await writeFile(join(TEST_DIR, '.pi-autopilot-telemetry.json'), JSON.stringify({ runs }), 'utf-8')
}

async function readTelemetryFile(): Promise<Array<Record<string, unknown>>> {
  const data = JSON.parse(await readFile(join(TEST_DIR, '.pi-autopilot-telemetry.json'), 'utf-8'))
  return data.runs
}

describe('scheduler: 预算拦截（防自锁）', () => {
  it('预算不通过时推进 nextRun 且不追加 failed 遥测（修复前每 30s 重复触发）', async () => {
    const task = makeTask()
    await writeTasksFile([task])
    // 50 条 = maxRunsPerDay 默认上限 → checkBudget 拦截
    await fillTelemetry(50)

    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)

    // nextRun 已推进到未来（修复前停留过去时刻，isDue 恒真）
    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string; history: unknown[] }
    expect(after.nextRun).toBeTruthy()
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.now())
    // 不记 failed：history 与遥测均无新增
    expect(after.history).toHaveLength(0)
    const runs = await readTelemetryFile()
    expect(runs).toHaveLength(50)
  })

  it('once 任务预算拦截时推迟而非丢弃（nextRun 不为 null）', async () => {
    const task = makeTask({ type: 'once', schedule: '+10m' })
    await writeTasksFile([task])
    await fillTelemetry(50)

    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)

    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string }
    expect(after.nextRun).toBeTruthy()
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.now())
  })

  it('预算充足时注入式执行：注入消息但不记 success（审计 MEDIUM 修复）', async () => {
    const task = makeTask()
    await writeTasksFile([task])
    await fillTelemetry(0)

    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('do something')
    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string; lastResult: string | null; history: Array<{ result: string }> }
    // 注入成功 ≠ 执行成功：不记 success、不写 history、无遥测（主会话执行结果未知）
    expect(after.lastResult).toBeNull()
    expect(after.history).toHaveLength(0)
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.now())
    const runs = await readTelemetryFile()
    expect(runs).toHaveLength(0)
  })
})
