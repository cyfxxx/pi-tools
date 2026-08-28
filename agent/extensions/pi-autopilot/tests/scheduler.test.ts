import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-scheduler-'))

// 结果同步隔离：fireTask/finalizeInjected 会写 daily-results，重定向到临时目录防污染
process.env.PI_DAILY_RESULTS_DIR = join(TEST_DIR, 'daily-results')

vi.mock('../watchdog.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, triggerHangRecovery: vi.fn(async () => false) }
})

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

    it('崩溃恢复旁路 markInjected 同样走 finalizeInjected 闭环（审计 MEDIUM：once 不重复执行、interval 回写）', async () => {
      const once = makeTask({ id: 'ro1', type: 'once', schedule: '2026-01-01T00:00:00Z' })
      const iv = makeTask({ id: 'riv', type: 'interval', intervalMinutes: 60 })
      await writeTasksFile([once, iv])
      const { SessionScheduler } = await import('../scheduler.ts')
      const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
      const sched = new SessionScheduler(pi as never)
      const api = sched as unknown as { markInjected: (id: string) => void; finalizeInjected: () => Promise<void> }
      const onceId = once.id as string
      const ivId = iv.id as string
      // 模拟 session_start 恢复路径：注入 + markInjected（不经过 fireTask）
      api.markInjected(onceId)
      api.markInjected(ivId)
      await sched.finalizeInjected()
      // once 任务被删除；interval 保留且 lastRun 已回写
      const tasks = (await readTasksFile()).tasks as Array<{ id: string; lastRun?: string }>
      expect(tasks.map(t => t.id)).not.toContain(onceId)
      const ivAfter = tasks.find(t => t.id === ivId)
      expect(ivAfter?.lastRun).toBeTruthy()
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

describe('scheduler: 本地模型提示分支（2026-08-24）', () => {
  it('waitForUserOnLocal + 本地模型：只发提示不自动执行，nextRun 推 1h', async () => {
    await writeFile(join(TEST_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'qwen2' }), 'utf-8')
    const task = makeTask({ id: 'local1', waitForUserOnLocal: true })
    await writeTasksFile([task])
    await fillTelemetry(0)
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)

    // 提示注入：含任务名与"未自动执行"，不含原始 prompt（不执行任务）
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('test-task')
    expect(sent[0]).toContain('未自动执行')
    expect(sent[0]).not.toContain('do something')
    // 不记执行：lastResult 保持 null、无遥测
    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string; lastResult: string | null }
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000)
    expect(after.lastResult).toBeNull()
    expect(await readTelemetryFile()).toHaveLength(0)
  })

  it('waitForUserOnLocal + 云端模型：正常注入执行', async () => {
    await writeFile(join(TEST_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'opencode-go', defaultModel: 'deepseek-v4-flash' }), 'utf-8')
    const task = makeTask({ id: 'local2', waitForUserOnLocal: true })
    await writeTasksFile([task])
    await fillTelemetry(0)
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('do something')
  })

  it('force=true（/schedule run 手动触发）跳过本地分支直接执行', async () => {
    await writeFile(join(TEST_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'qwen2' }), 'utf-8')
    const task = makeTask({ id: 'local3', waitForUserOnLocal: true })
    await writeTasksFile([task])
    await fillTelemetry(0)
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { fireTask: (t: unknown, f: boolean) => Promise<void> }).fireTask(task, true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('do something')
  })
})

describe('scheduler: enabled 门控（2026-08-25 审计 HIGH 修复）', () => {
  it('enabled=false 时 tick 不触发到期任务（修复前任务照跑且预算检查被跳过）', async () => {
    const task = makeTask({ id: 'gated1' })
    await writeTasksFile([task])
    await writeFile(join(TEST_DIR, '.pi-autopilot-config.json'), JSON.stringify({ enabled: false }), 'utf-8')
    await fillTelemetry(0)
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { tick: () => Promise<void> }).tick()

    expect(sent).toHaveLength(0)
    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string; history: unknown[] }
    // 未执行：nextRun 保持到期时刻（enabled 恢复后可正常触发）、无遥测
    expect(new Date(after.nextRun).getTime()).toBeLessThanOrEqual(Date.now())
    expect(after.history).toHaveLength(0)
    expect(await readTelemetryFile()).toHaveLength(0)
  })

  it('enabled=true（缺省）时 tick 正常注入到期任务', async () => {
    const task = makeTask({ id: 'gated2' })
    await writeTasksFile([task])
    // 前一用例残留 enabled=false，显式写 true 隔离
    await writeFile(join(TEST_DIR, '.pi-autopilot-config.json'), JSON.stringify({ enabled: true }), 'utf-8')
    await fillTelemetry(0)
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (m: string) => { sent.push(m) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { tick: () => Promise<void> }).tick()
    expect(sent).toHaveLength(1)
  })
  it('enabled=false 但主会话挂死时看门狗仍恢复（2026-08-26 审计 MEDIUM：watchdog 与调度门控正交）', async () => {
    // 集成分界：真实挂死判定（时钟/env/会话 mtime 多信号）由 watchdog.test.ts 覆盖；
    // 此处只验证 scheduler.tick 在 enabled=false 时仍调用看门狗并对 true 结果执行恢复。
    const wd = await import('../watchdog.ts')
    const trig = wd.triggerHangRecovery as unknown as ReturnType<typeof vi.fn>
    trig.mockResolvedValue(true)
    const task = makeTask({ id: 'wd1' })
    await writeTasksFile([task])
    await writeFile(join(TEST_DIR, '.pi-autopilot-config.json'), JSON.stringify({ enabled: false }), 'utf-8')
    await fillTelemetry(0)
    const { SessionScheduler } = await import('../scheduler.ts')
    const shutdowns: number[] = []
    const pi = { sendUserMessage: async (_m: string) => {}, shutdown: () => { shutdowns.push(1) } }
    const sched = new SessionScheduler(pi as never)
    // 注意：tick 内部 catch { /* suppress tick errors */ } 会吞掉一切异常——
    // 不能用「mock exit 抛错再断言 rejects」的方式；改为 exit no-op + 断言调用副作用
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      await (sched as unknown as { tick: () => Promise<void> }).tick()
      // 断言必须在 mockReset 之前（reset 会清空调用记录）
      expect(trig).toHaveBeenCalledWith(180)
      expect(exitSpy).toHaveBeenCalledWith(0)
      expect(shutdowns).toHaveLength(1)
      const saved = await readTasksFile()
      expect((saved.tasks[0] as { history: unknown[] }).history ?? []).toHaveLength(0)
    } finally {
      exitSpy.mockRestore()
      trig.mockReset()
    }
  })

})

describe('scheduler: abort 回合不闭环 success（2026-08-25 审计实测修复）', () => {
  it('markRunAborted(true) 后 finalizeInjected 仅推进 nextRun，不记 success/不删 once/不发 webhook', async () => {
    const task = makeTask({ id: 'abort1', type: 'once', schedule: '+10m', notifyOnCompletion: true })
    await writeTasksFile([task])
    await writeFile(join(TEST_DIR, '.pi-autopilot-config.json'), JSON.stringify({ enabled: true }), 'utf-8')
    await fillTelemetry(0)
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    sched.markInjected('abort1')
    sched.markRunAborted(true)
    await (sched as unknown as { finalizeInjected: () => Promise<void> }).finalizeInjected()

    const saved = await readTasksFile()
    const after = saved.tasks[0] as { nextRun: string; history: unknown[] }
    // once 任务保留（未删）、nextRun 推进到未来（防 tick 重复注入）、无 history/遥测
    expect(after).toBeTruthy()
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.now())
    expect(after.history ?? []).toHaveLength(0)
    expect(await readTelemetryFile()).toHaveLength(0)
  })

  it('非中止回合后 finalize 行为不变（once 删除 + telemetry 补记）', async () => {
    const task = makeTask({ id: 'norm1', type: 'once', schedule: '+10m' })
    await writeTasksFile([task])
    await fillTelemetry(0)
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    sched.markInjected('norm1')
    await (sched as unknown as { finalizeInjected: () => Promise<void> }).finalizeInjected()
    const saved = await readTasksFile()
    expect((saved.tasks as unknown[]).find((t) => (t as { id: string }).id === 'norm1')).toBeUndefined()
    expect(await readTelemetryFile()).toHaveLength(1)
  })
})

// ── 审计修复回归（2026-08-26）─────────────────────────────
// 审计：sendUserMessage 不可用的错误被 errClassOf 归 unknown → decide 判 failover
// 换模型重启（不解决根因）。修复：fireViaMessage 自身抛的错误带 envFailure 标记，
// fireTask catch 识别后降级为普通失败（重试/暂停），不写重启请求、不递增 failoverCount。
describe('scheduler: 注入环境故障不触发 failover（审计修复）', () => {
  it('sendUserMessage 不可用：按普通失败处理，无重启请求/无 failoverCount/不退进程', async () => {
    // failCount=2 存储 + decide 预+1=3 ≥ failoverAfter(2) 且配置 fallbackModels
    // → 修复前必走 failover（executeFailover 写 set_model + process.exit(0)）
    const task = makeTask({ id: 'env1', failCount: 2 })
    await writeTasksFile([task])
    await fillTelemetry(0)
    await writeFile(join(TEST_DIR, '.pi-autopilot-config.json'), JSON.stringify({
      fallbackModels: [{ provider: 'p2', model: 'm2' }],
    }), 'utf-8')

    const { SessionScheduler } = await import('../scheduler.ts')
    const { readState } = await import('../state.ts')
    const pi = { shutdown: () => {} } // 无 sendUserMessage → 注入必失败
    const sched = new SessionScheduler(pi as never)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      await (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)
      // 不退进程、不写重启请求（修复前 failover 分支两者皆发生）
      expect(exitSpy).not.toHaveBeenCalled()
      expect(readState().restartLog).toBeNull()
      // 按普通失败记账：任务未暂停、failoverCount 未递增、note 标注抑制
      const saved = await readTasksFile()
      const after = saved.tasks[0] as { failoverCount?: number; enabled: boolean; history: Array<{ output: string }> }
      expect(after.enabled).toBe(true)
      expect(after.failoverCount ?? 0).toBe(0)
      expect(after.history[0].output).toContain('failover 已抑制')
      // 遥测仍记 failed（按普通失败重试/暂停语义），errClass unknown
      const runs = await readTelemetryFile()
      expect(runs).toHaveLength(1)
      expect(runs[0].result).toBe('failed')
      expect(runs[0].errClass).toBe('unknown')
    } finally {
      exitSpy.mockRestore()
    }
  })
})

// 审计：tick 内 for-await 串行 fireTask 多任务到期线性累积——改 Promise.allSettled
// 并发（fireTask 入口同步登记 firing 去重，无重复触发）
describe('scheduler: tick 并发触发（审计修复）', () => {
  it('多个到期任务并发 fireTask（最大同时在飞 2，串行修复前为 1）', async () => {
    const t1 = makeTask({ id: 'cc1', name: 'cc1' })
    const t2 = makeTask({ id: 'cc2', name: 'cc2' })
    await writeTasksFile([t1, t2])
    await fillTelemetry(0)

    let active = 0
    let maxActive = 0
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = {
      sendUserMessage: async (m: string) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 50))
        active--
        sent.push(m)
      },
      shutdown: () => {},
    }
    const sched = new SessionScheduler(pi as never)
    await (sched as unknown as { tick: () => Promise<void> }).tick()
    expect(sent).toHaveLength(2)
    expect(maxActive).toBe(2)
  })
})
