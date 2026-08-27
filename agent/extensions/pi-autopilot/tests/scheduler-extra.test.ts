import { describe, it, expect, vi, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFile, readFile, mkdir, rm } from 'fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 隔离：os.homedir() 优先读 $HOME，改写 worker 进程 HOME 即可隔离节流戳与真实 ~/.pi
const TEST_DIR = join(tmpdir(), `pi-autopilot-extra-${Date.now()}`)

// 结果同步隔离：调度执行写 daily-results，重定向到临时目录防污染真实主目录
process.env.PI_DAILY_RESULTS_DIR = join(TEST_DIR, 'daily-results')
process.env.HOME = TEST_DIR
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

await mkdir(join(TEST_DIR, '.pi', 'logs', 'scheduler'), { recursive: true })

afterAll(async () => {
  vi.restoreAllMocks()
  delete process.env.HOME
  await rm(TEST_DIR, { recursive: true, force: true })
})

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1', name: 'test-task', type: 'interval', schedule: '5m', prompt: 'do something',
    enabled: true, useSubagent: false, notifyOnCompletion: false, maxRunTime: 300,
    nextRun: new Date(Date.now() - 60000).toISOString(), lastRun: null, lastResult: null,
    lastOutput: '', failCount: 0, runCount: 0, history: [], retries: 0,
    recoveryCount: 0, pendingInject: false, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), ...overrides,
  }
}

async function writeTasksFile(tasks: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(join(TEST_DIR, 'scheduled-tasks.json'), JSON.stringify({ version: 3, settings: {}, tasks }), 'utf-8')
}

describe('maybeTriggerSummarizer 节流（任务完成即沉淀，2026-08-24）', () => {
  it('15 分钟内多次调用只 spawn 一次；游标戳过期后再次 spawn', async () => {
    const { spawn } = await import('node:child_process')
    const m = spawn as unknown as ReturnType<typeof vi.fn>
    m.mockReset()
    m.mockReturnValue({ unref: vi.fn() })

    const { maybeTriggerSummarizer } = await import('../scheduler.ts')
    await maybeTriggerSummarizer()
    expect(m).toHaveBeenCalledTimes(1)
    const [cmd, args] = m.mock.calls[0]
    expect(cmd).toContain('node')
    expect(String(args[0])).toContain('task-summarizer.mjs')

    // 节流：立即再触发不 spawn
    await maybeTriggerSummarizer()
    expect(m).toHaveBeenCalledTimes(1)

    // 戳过期（20 分钟前）→ 再次 spawn
    const { writeFile: wf } = await import('fs/promises')
    await wf(join(TEST_DIR, '.pi', 'logs', 'scheduler', 'summarizer.last'), String(Date.now() - 20 * 60_000))
    await maybeTriggerSummarizer()
    expect(m).toHaveBeenCalledTimes(2)
  })
})

describe('notifyMain：后台会话任务完成 → stdout 收尾注入主会话（2026-08-24）', () => {
  it('close(0) 后把 stdout 尾部摘要发送给主会话（含任务名与完成标记）', async () => {
    const { spawn } = await import('node:child_process')
    const m = spawn as unknown as ReturnType<typeof vi.fn>
    m.mockReset()
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.pid = 4242
    m.mockReturnValue(proc)

    const task = makeTask({ id: 'nm1', useSubagent: true, notifyMain: true })
    await writeTasksFile([task])
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (msg: string) => { sent.push(msg) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await writeFile(join(TEST_DIR, '.pi-autopilot-telemetry.json'), JSON.stringify({ runs: [] }), 'utf-8')

    const p = (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)
    // 等 fireTask 推进到 fireViaSubagent 挂起点（attach 完 close 监听），再派发事件
    await new Promise(r => setTimeout(r, 100))
    // 派发子进程输出与退出
    proc.stdout.emit('data', Buffer.from('昨日命中率 97%，知识订阅新增 12 条……详细收尾报告'))
    proc.emit('close', 0)
    await p

    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('[Scheduler] test-task 已完成')
    expect(sent[0]).toContain('详细收尾报告')
  })

  it('notifyMain=false 不向主会话发完成消息', async () => {
    const { spawn } = await import('node:child_process')
    const m = spawn as unknown as ReturnType<typeof vi.fn>
    m.mockReset()
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.pid = 4243
    m.mockReturnValue(proc)

    const task = makeTask({ id: 'nm2', useSubagent: true, notifyMain: false })
    await writeTasksFile([task])
    const sent: string[] = []
    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async (msg: string) => { sent.push(msg) }, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)
    await writeFile(join(TEST_DIR, '.pi-autopilot-telemetry.json'), JSON.stringify({ runs: [] }), 'utf-8')

    const p = (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(task)
    await new Promise(r => setTimeout(r, 100))
    proc.stdout.emit('data', Buffer.from('输出'))
    proc.emit('close', 0)
    await p
    expect(sent).toHaveLength(0)
  })
})

describe('fireTask 失败决策：decide 前从 store 重读 failCount（审计 LOW）', () => {
  it('入参快照过期时按存储最新值 +本次失败决策：达 suspendAfter 即暂停任务', async () => {
    const { spawn } = await import('node:child_process')
    const m = spawn as unknown as ReturnType<typeof vi.fn>
    m.mockReset()
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number }
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.pid = 4244
    m.mockReturnValue(proc)

    // 存储中已连续失败 4 次；传给 fireTask 的入参快照是过期的 failCount=0。
    // stderr 避开 provider/logic 关键词 → errClass=unknown，走 suspendAfter 分支（默认 5）
    const stored = makeTask({ id: 'dc1', useSubagent: true, failCount: 4 })
    await writeTasksFile([stored])
    await writeFile(join(TEST_DIR, '.pi-autopilot-telemetry.json'), JSON.stringify({ runs: [] }), 'utf-8')

    const { SessionScheduler } = await import('../scheduler.ts')
    const pi = { sendUserMessage: async () => {}, shutdown: () => {} }
    const sched = new SessionScheduler(pi as never)

    // 修复前：decide 用快照 failCount=0 → 不达阈值 → 仅记 fail、enabled 保持 true
    // 修复后：重读存储 4，预 +1 = 5 ≥ suspendAfter → suspend_task（enabled=false）
    const stale = { ...stored, failCount: 0 }
    const p = (sched as unknown as { fireTask: (t: unknown) => Promise<void> }).fireTask(stale)
    // 等 fireTask 推进到 fireViaSubagent 挂起点（attach 完 close 监听），再派发失败退出
    await new Promise(r => setTimeout(r, 100))
    proc.emit('close', 1)
    await p

    const saved = JSON.parse(await readFile(join(TEST_DIR, 'scheduled-tasks.json'), 'utf8')) as {
      tasks: Array<{ id: string; enabled: boolean; failCount: number; lastResult: string | null }>
    }
    const after = saved.tasks.find(t => t.id === 'dc1')!
    expect(after.enabled).toBe(false)
    expect(after.failCount).toBe(5) // updateTaskAfterRun 在决策后递增：4+1
    expect(after.lastResult).toBe('failed')
  })
})