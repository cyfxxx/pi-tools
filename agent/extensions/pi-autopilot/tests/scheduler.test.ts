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

  describe('scheduler: 注入式任务最终化（finalizeInjected 补闭环）', () => {
    it('once 任务注入经 agent_settled 最终化后删除（修复前每小时重复注入、永不删除）', async () => {
      const task = makeTask({ id: 'o1', type: 'once', schedule: '2026-01-01T00:00:00Z' })
      await writeTasksFile([task])
      const { SessionScheduler } = await import('../scheduler.ts')
      const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
      const sched = new SessionScheduler(pi as never)
      await (sched as unknown as { fireTask: (t: unknown) => Promise<void>; finalizeInjected: () => Promise<void> }).fireTask(task)
      // 注入后任务仍在（半闭环残留：+1h 缓冲，未删）
      expect((await readTasksFile()).tasks).toHaveLength(1)
      // agent_settled → finalizeInjected：once 删除
      await sched.finalizeInjected()
      expect((await readTasksFile()).tasks).toHaveLength(0)
    })

    it('interval 任务最终化：回写 lastResult + 重置 failoverCount + nextRun 按调度推进', async () => {
      const task = makeTask({ failoverCount: 3, failCount: 2, history: [] })
      await writeTasksFile([task])
      const { SessionScheduler } = await import('../scheduler.ts')
      const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
      const sched = new SessionScheduler(pi as never)
      await (sched as unknown as { fireTask: (t: unknown) => Promise<void>; finalizeInjected: () => Promise<void> }).fireTask(task)
      await sched.finalizeInjected()
      const after = (await readTasksFile()).tasks[0] as {
        lastResult: string | null; failoverCount: number; failCount: number; nextRun: string; history: Array<{ result: string }>
      }
      expect(after.lastResult).toBe('success')
      expect(after.failoverCount).toBe(0)
      expect(after.failCount).toBe(0)
      expect(after.history[after.history.length - 1].result).toBe('success')
      // nextRun 推进到 5m 之后（computeNextRun），非 +1h 缓冲
      const delta = new Date(after.nextRun).getTime() - Date.now()
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBeLessThan(15 * 60_000)
    })

    it('notifyOnCompletion 最终化时补发 success webhook（与 subagent 路径对齐）', async () => {
      const task = makeTask({ id: 'w1', notifyOnCompletion: true })
      await writeTasksFile([task])
      const { SessionScheduler } = await import('../scheduler.ts')
      const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
      const sched = new SessionScheduler(pi as never)
      await (sched as unknown as { fireTask: (t: unknown) => Promise<void>; finalizeInjected: () => Promise<void> }).fireTask(task)
      // 无 webhookUrl 的任务：sendWebhook 内部应安全跳过（不抛错）
      await expect(sched.finalizeInjected()).resolves.toBeUndefined()
    })

    it('任务已被删除时 finalize 安全跳过（updateTaskAfterRun 内部 findIndex -1）', async () => {
      const { SessionScheduler } = await import('../scheduler.ts')
      const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
      const sched = new SessionScheduler(pi as never)
      // 不写任务文件直接 finalize：tasks=[] → 空跑
      await expect(sched.finalizeInjected()).resolves.toBeUndefined()
      // 注入后立即删除任务 → finalize 跳过
      const task = makeTask({ id: 'g1' })
      await writeTasksFile([task])
      await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)
      await writeTasksFile([])
      await sched.finalizeInjected()
      expect((await readTasksFile()).tasks).toHaveLength(0)
    })
  })
})
