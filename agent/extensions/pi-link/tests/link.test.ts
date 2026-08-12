import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { extractReply, buildRemoteCommand, sendToDevice } from '../link'
import type { DeviceConfig } from '../config'

// vi.mock 顶部提升注册：模块加载即生效（doMock 无法覆盖静态 import 的预加载）
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock, exec: vi.fn(), execSync: vi.fn() }))

const DEV: DeviceConfig = { host: '100.64.0.1', user: 'testuser', port: 2222 }

const EV = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra })

describe('pi-link: extractReply', () => {
  it('提取最后一个 assistant 的 text blocks（排除 thinking/toolCall）', () => {
    const events = [
      EV('message_end', { message: { role: 'assistant', content: [{ type: 'thinking', text: '想' }, { type: 'text', text: '第一段' }] } }),
      EV('message_end', { message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1' }, { type: 'text', text: '最终回复' }], model: 'm1' } }),
    ]
    const r = extractReply(events)
    expect(r.text).toBe('最终回复')
    expect(r.model).toBe('m1')
  })

  it('多 text block 拼接；无 assistant 时为空', () => {
    const r = extractReply([
      EV('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }),
    ])
    expect(r.text).toBe('a\nb')
    expect(extractReply([EV('agent_settled')]).text).toBe('')
  })

  it('content 为字符串时直接使用', () => {
    const r = extractReply([EV('message_end', { message: { role: 'assistant', content: 'plain' } })])
    expect(r.text).toBe('plain')
  })
})

describe('pi-link: buildRemoteCommand', () => {
  it('默认 --no-extensions + 默认 session dir + LD_PRELOAD 清除', () => {
    const cmd = buildRemoteCommand(DEV, {})
    expect(cmd.startsWith('unset LD_PRELOAD 2>/dev/null;')).toBe(true)
    expect(cmd).toContain('--mode rpc --no-extensions --session-dir ~/.pi/agent/sessions/pi-link')
    // 绕过 wrapper：node + 真实 cli.js 优先
    expect(cmd).toContain('readlink -f')
    expect(cmd).toContain('command -v pi-original')
  })
  it('extensions 开启时省略 --no-extensions', () => {
    expect(buildRemoteCommand(DEV, { extensions: true })).toContain('pi --mode rpc')
    expect(buildRemoteCommand(DEV, { extensions: true })).not.toContain('--no-extensions')
  })
  it('cwd 包装为 cd 前缀', () => {
    expect(buildRemoteCommand(DEV, { cwd: '~/work' })).toContain('cd "~/work" && unset LD_PRELOAD')
  })
  it('自定义 sessionDir', () => {
    expect(buildRemoteCommand(DEV, { sessionDir: '/tmp/x' })).toContain('--session-dir /tmp/x')
  })
})

describe('pi-link: sendToDevice', () => {
  let sshMock: { spawn: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    sshMock = { spawn: vi.fn() }
    vi.doMock('node:child_process', () => ({ spawn: sshMock.spawn, exec: vi.fn(), execSync: vi.fn() }))
  })

  function fakeProc(lines: Array<Record<string, unknown>>, { reply = 'ok', exitCode = 0 } = {}) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const exitCbs: Array<(code: number) => void> = []
    const proc = {
      stdin, stdout, stderr,
      kill: vi.fn(),
      on: (ev: string, cb: (code: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
    }
    // 模拟 stdin 写入后事件流；事件发完后再触发 exit（保证 readline 先收完事件）
    stdin.on('data', () => {
      const seq = [
        { type: 'agent_start' },
        { type: 'turn_start' },
        ...(reply ? [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }] : []),
        ...lines,
      ]
      setImmediate(() => {
        for (const l of seq) stdout.emit('data', JSON.stringify(l) + '\n')
        setImmediate(() => {
          stdout.emit('end')
          for (const cb of exitCbs) cb(exitCode)
        })
      })
    })
    return proc
  }

  it('完整流程: prompt → agent_settled → 返回最终回复与统计', async () => {
    spawnMock.mockImplementation(() => fakeProc([
      { type: 'tool_execution_end' },
      { type: 'turn_end' },
      { type: 'agent_settled' },
    ]))
    const r = await sendToDevice(DEV, 'hello', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('ok')
    expect(r.turns).toBe(1)
    expect(r.tools).toBe(1)
    // ssh 参数含 BatchMode + user@host + 远程命令
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args.join(' ')).toContain('testuser@100.64.0.1')
    expect(args.join(' ')).toContain('pi --mode rpc')
  })

  it('agent 请求交互时返回错误', async () => {
    spawnMock.mockImplementation(() => fakeProc([
      { type: 'extension_ui_request', request: { id: 1 } },
      { type: 'agent_settled' },
    ]))
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('用户交互')
  })

  it('无文本回复时报错并附 stderr', async () => {
    const proc = fakeProc([{ type: 'agent_settled' }], { reply: '' })
    spawnMock.mockImplementation(() => {
      // stderr 输出在 sendToDevice 注册 listener 之后到达
      setImmediate(() => proc.stderr.emit('data', 'pi: command not found\n'))
      return proc
    })
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('command not found')
  })
})
