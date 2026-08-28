import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-commands-'))
process.env.PI_DAILY_RESULTS_DIR = join(TEST_DIR, 'daily-results')

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

// failover mock：不落真实重启请求，专注命令分支行为（shutdown/exit 兜底）
vi.mock('../failover.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    planFailover: vi.fn(async () => ({ target: { provider: 'p2', model: 'm2' }, reason: 'p1/m1 → p2/m2' })),
    executeFailover: vi.fn(async () => '正在切换模型 p2/m2 并重启...'),
  }
})

import { registerCommands } from '../commands.ts'
import { executeFailover } from '../failover.ts'
import { readState } from '../state.ts'

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

function mockPi() {
  return {
    registerTool: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(),
    registerShortcut: vi.fn(), on: vi.fn(), sendMessage: vi.fn(),
    appendEntry: vi.fn(), sendUserMessage: vi.fn(), setActiveTools: vi.fn(),
  }
}

function makeCmd(pi: ReturnType<typeof mockPi>, scheduler: unknown = { runNow: vi.fn(async () => {}) }) {
  registerCommands(pi as never, scheduler as never)
  const auto = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'auto')![1]
  const schedule = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 'schedule')![1]
  return { auto: auto.handler as (a: string, c: unknown) => Promise<void>, schedule: schedule.handler as (a: string, c: unknown) => Promise<void> }
}

function sentTexts(pi: ReturnType<typeof mockPi>): string[] {
  return (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0].content))
}

// 审计（2026-08-26）：/auto failover --exec 只写 set_model 重启请求不退进程，
// 请求可被 watchdog restart_hang 覆盖——对齐 /auto restart 补 shutdown + 兜底强退
describe('/auto failover --exec（审计修复：shutdown + process.exit 兜底）', () => {
  it('执行切换后调用 ctx.shutdown，并在 1.5s 兜底 process.exit(0)', async () => {
    const pi = mockPi()
    const { auto } = makeCmd(pi)
    const ctx = { ui: { confirm: vi.fn(async () => true), notify: vi.fn() }, shutdown: vi.fn() }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await auto('failover --exec', ctx)
      expect(executeFailover).toHaveBeenCalledTimes(1)
      expect(ctx.shutdown).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1500)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
      exitSpy.mockRestore()
    }
  })

  it('dry-run（无 --exec）不退进程、不触发 shutdown', async () => {
    const pi = mockPi()
    const { auto } = makeCmd(pi)
    const ctx = { ui: { confirm: vi.fn(async () => true), notify: vi.fn() }, shutdown: vi.fn() }
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      await auto('failover', ctx)
      expect(sentTexts(pi).join('\n')).toContain('dry-run')
      expect(ctx.shutdown).not.toHaveBeenCalled()
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  })
})

// 审计（2026-08-26）：/schedule run 直接 find 原始 store 未过滤 deleted 墓碑——
// 陈旧副本可被 runNow 写回复活。改用 listTasks()（内部过滤 deleted）
describe('/schedule run（deleted 墓碑过滤，审计修复）', () => {
  it('deleted 任务按不存在处理；存活任务正常触发', async () => {
    await writeFile(join(TEST_DIR, 'scheduled-tasks.json'), JSON.stringify({
      version: 3,
      settings: {},
      tasks: [
        { id: 'gone', name: 'gone', type: 'interval', schedule: '5m', prompt: 'x', enabled: true, deleted: true, tags: [], history: [] },
        { id: 'live', name: 'live', type: 'interval', schedule: '5m', prompt: 'y', enabled: true, tags: [], history: [] },
      ],
    }), 'utf-8')
    const pi = mockPi()
    const runNow = vi.fn(async (_task?: { id?: string }) => {})
    const { schedule } = makeCmd(pi, { runNow })
    const ctx = { ui: { confirm: vi.fn(async () => true), notify: vi.fn() } }

    await schedule('run gone', ctx)
    expect(sentTexts(pi).join('\n')).toContain('未找到任务: gone')
    expect(runNow).not.toHaveBeenCalled()

    await schedule('run live', ctx)
    expect(runNow).toHaveBeenCalledTimes(1)
    expect((runNow.mock.calls[0][0] as { id: string }).id).toBe('live')
    expect(sentTexts(pi).join('\n')).toContain('已触发任务 "live"')
  })
})

// 状态文件兜底断言（executeFailover mock 不落盘；readState 可用性冒烟）
describe('state 冒烟', () => {
  it('readState 默认无重启请求', () => {
    expect(readState().restartLog).toBeNull()
  })
})
