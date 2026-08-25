import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 审计：detectTmuxSession 启动时一次性捕获，tmux 会话改名（rename-session /
// resurrect 恢复）后快照失效——远程 attach 打错目标。修复为 writeLocalState
// 每次回写时惰性重探（探测廉价）。本文件 mock node:child_process 控制 execSync。
const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  exec: vi.fn(),
  spawn: vi.fn(),
}))

const mockPi = () => ({
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  registerFlag: vi.fn(),
  registerShortcut: vi.fn(),
  on: vi.fn(),
  sendMessage: vi.fn(),
})

let dir: string

const onHandler = (pi: ReturnType<typeof mockPi>, ev: string): ((e?: unknown) => unknown) => {
  const call = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === ev)
  if (!call) throw new Error(`未注册事件 ${ev}`)
  return call[1] as (e?: unknown) => unknown
}
const readStateFile = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, 'pi-link-state.json'), 'utf-8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-link-tmux-'))
  process.env.PI_LINK_STATE_DIR = dir
  process.env.TMUX = '/tmp/tmux-0/default,123,0'
  execSyncMock.mockReset()
})

afterEach(() => {
  delete process.env.PI_LINK_STATE_DIR
  delete process.env.TMUX
  rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('pi-link index: tmux 会话惰性重探', () => {
  it('每次回写重新探测：会话改名后状态文件跟上（不再用启动时快照）', async () => {
    execSyncMock.mockImplementation(() => 'old-session\n')
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    // 启动即写 idle：探测一次
    expect(readStateFile().tmuxSession).toBe('old-session')

    // 会话改名 → agent_settled 回写应拿到新名字（回归：修复前永远 old-session）
    execSyncMock.mockImplementation(() => 'renamed-session\n')
    await onHandler(pi, 'agent_settled')({})
    expect(execSyncMock).toHaveBeenCalledTimes(2)
    expect(readStateFile().tmuxSession).toBe('renamed-session')

    // turn_start 同样走惰性探测
    execSyncMock.mockImplementation(() => 'third-name\n')
    await onHandler(pi, 'turn_start')({})
    expect(readStateFile().tmuxSession).toBe('third-name')
    expect(readStateFile().status).toBe('busy')
  })

  it('探测失败（execSync 抛错）时回写不崩、tmuxSession 置空', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('no tmux here')
    })
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const s0 = readStateFile()
    expect(s0.tmuxSession).toBeUndefined()
    expect(s0.status).toBe('idle')
    await onHandler(pi, 'agent_settled')({})
    expect(readStateFile().tmuxSession).toBeUndefined()
  })
})
