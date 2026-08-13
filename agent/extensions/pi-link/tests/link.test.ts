import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { extractReply, buildRemoteCommand, sendToDevice, wrapTaskMessage, resetSendGuards } from '../link'
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

describe('pi-link: 并发与去重（T2-4）', () => {
  it('同设备并发调用被拒', async () => {
    const { checkConcurrentAndDedup, markSendStart, markSendEnd } = await import('../link.ts')
    const key = 'a@b:22'
    expect(checkConcurrentAndDedup(key, 'm1').ok).toBe(true)
    markSendStart(key, 'm1')
    const r = checkConcurrentAndDedup(key, 'm2')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('已有进行中')
    markSendEnd(key)
    expect(checkConcurrentAndDedup(key, 'm2').ok).toBe(true)
  })

  it('窗口内相同消息去重；不同消息放行', async () => {
    const { checkConcurrentAndDedup, markSendStart, markSendEnd } = await import('../link.ts')
    const key = 'a@b:22'
    markSendStart(key, '重复消息')
    markSendEnd(key) // 发送完成：in-flight 清除，hash 记录保留
    const r1 = checkConcurrentAndDedup(key, '重复消息')
    expect(r1.ok).toBe(false)
    expect(r1.detail).toContain('去重')
    expect(checkConcurrentAndDedup(key, '另一个消息').ok).toBe(true)
  })

  it('窗口过期后同消息放行', async () => {
    vi.useFakeTimers()
    try {
      const { checkConcurrentAndDedup, markSendStart, markSendEnd } = await import('../link.ts')
      const key = 'a@b:22'
      markSendStart(key, 'x')
      markSendEnd(key)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
      expect(checkConcurrentAndDedup(key, 'x').ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sendToDevice 直接返回拒绝（不 spawn）', async () => {
    spawnMock.mockImplementation(() => { throw new Error('不应 spawn') })
    const { sendToDevice } = await import('../link.ts')
    const key = 'testuser@100.64.0.1:2222'
    markSendStartFor(key, '')
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已有进行中')
  })
})

// 辅助：直接置 in-flight（sendToDevice 内部函数不可直接调用时用）
import { markSendStart as markSendStartFor } from '../link.ts'
// markSendStart 的 message 仅用于去重记录，测试置空即可

describe('pi-link: buildRemoteCommand', () => {
  it('默认 --no-extensions + 默认 session dir + LD_PRELOAD 清除', () => {
    const cmd = buildRemoteCommand(DEV, {})
    expect(cmd.startsWith('unset LD_PRELOAD 2>/dev/null;')).toBe(true)
    expect(cmd).toContain('--mode rpc --no-extensions --session-dir ~/.pi/agent/sessions/pi-link')
    // 绕过 wrapper：node + 真实 cli.js 优先
    expect(cmd).toContain('readlink -f')
    expect(cmd).toContain('command -v pi-original')
  })

  it('会话连续性：continue 策略含上次会话探测，fresh 策略无', () => {
    const cont = buildRemoteCommand(DEV, {})
    expect(cont).toContain('PI_LINK_LAST_SESSION')
    expect(cont).toContain('ls -t "~/.pi/agent/sessions/pi-link"/*.jsonl')
    const fresh = buildRemoteCommand(DEV, { sessionPolicy: 'fresh' })
    expect(fresh).not.toContain('PI_LINK_LAST_SESSION')
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

describe('pi-link: wrapTaskMessage (T1-3)', () => {
  it('注入远程执行指令前缀', () => {
    const w = wrapTaskMessage('查看当前目录文件')
    expect(w).toContain('[远程执行任务]')
    expect(w).toContain('不要询问"回复给谁')
    expect(w).toContain('查看当前目录文件')
  })
  it('带发起设备名', () => {
    const w = wrapTaskMessage('执行', 'laptop')
    expect(w).toContain('发起设备: laptop')
  })
})

describe('pi-link: sendToDevice', () => {
  let sshMock: { spawn: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    resetSendGuards()
    sshMock = { spawn: vi.fn() }
    vi.doMock('node:child_process', () => ({ spawn: sshMock.spawn, exec: vi.fn(), execSync: vi.fn() }))
  })

  const stdinWrites: string[] = []
  function fakeProc(lines: Array<Record<string, unknown>>, { reply = 'ok', exitCode = 0 } = {}) {
    const writes: string[] = []
    stdinWrites.length = 0
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
    stdin.on('data', (chunk: Buffer) => {
      writes.push(chunk.toString())
      stdinWrites.push(chunk.toString())
      // switch_session 命令 → 回 response（模拟远程确认）
      if (chunk.toString().includes('"type":"switch_session"')) {
        setImmediate(() => {
          stdout.emit('data', JSON.stringify({ type: 'response', id: 'pi-link-0', command: 'switch_session', success: true }) + '\n')
        })
      }
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

  it('会话连续性：握手行后发 switch_session（等响应）再发 prompt', async () => {
    const proc = fakeProc([{ type: 'agent_settled' }])
    spawnMock.mockImplementation(() => {
      // 模拟远程 shell 先输出握手行，再进入 RPC 事件流
      setImmediate(() => proc.stdout.emit('data', 'PI_LINK_LAST_SESSION=/root/.pi/agent/sessions/pi-link/x.jsonl\n'))
      return proc
    })
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    expect(r.resumed).toBe(true)
    const all = stdinWrites.join('')
    expect(all).toContain('"type":"switch_session"')
    expect(all).toContain('/root/.pi/agent/sessions/pi-link/x.jsonl')
    expect(all).toContain('"type":"prompt"')
    expect(all).toContain('[远程执行任务]')
    // switch 响应在 prompt 之前
    expect(stdinWrites.findIndex((w) => w.includes('switch_session'))).toBeLessThan(
      stdinWrites.findIndex((w) => w.includes('"type":"prompt"'))
    )
  })

  it('无握手行时直接发 prompt（fresh/首次）', async () => {
    spawnMock.mockImplementation(() => fakeProc([{ type: 'agent_settled' }]))
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    expect(r.resumed).toBe(false)
    const all = stdinWrites.join('')
    expect(all).not.toContain('switch_session')
  })

  it('wrapTask=false 时不注入指令模板', async () => {
    spawnMock.mockImplementation(() => fakeProc([{ type: 'agent_settled' }]))
    await sendToDevice(DEV, 'hi', { timeoutSec: 30, wrapTask: false })
    expect(stdinWrites.join('')).not.toContain('[远程执行任务]')
  })

  it('attachToRemote: 输入框空时粘贴+回车；有内容时等清空只粘贴', async () => {
    const calls: string[] = []
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] ?? []) as string[]
      const cmd = String(argv[argv.length - 1] ?? '')
      calls.push(cmd)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      const proc = {
        stdin, stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
      }
      const exitCbs: Array<(c: number) => void> = []
      setImmediate(() => {
        // 状态文件：idle + tmuxSession
        if (cmd.includes('pi-link-state.json')) {
          stdout.emit('data', JSON.stringify({ device: 'r', status: 'idle', tmuxSession: '0' }) + '\n')
        } else if (cmd.includes('capture-pane')) {
          // 空输入框：分隔线 + ~ + 状态栏（无内容行）
          stdout.emit('data', '\u2500\u2500\u2500\n\n~\ndeeepseek-v4-flash • max\n')
        } else {
          stdout.emit('data', '\n')
        }
        setImmediate(() => { for (const cb of exitCbs) cb(0) })
      })
      return proc
    })
    const { attachToRemote } = await import('../link.ts')
    const r = await attachToRemote(DEV, 'hi')
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('并回车')
    const last = calls[calls.length - 1]
    expect(last).toContain('send-keys')
    expect(last).toContain('Enter')
  })

  it('attachToRemote: busy 时拒绝，force 强制', async () => {
    // 独立 mock：每次 ssh 调用返回可控的 stdout + 触发 exit
    spawnMock.mockImplementation((...args: unknown[]) => {
      const argv = (args[1] ?? []) as string[]
      const cmd = String(argv[argv.length - 1] ?? '')
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      const proc = {
        stdin, stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
      }
      const exitCbs: Array<(c: number) => void> = []
      if (cmd.includes('pi-link-state.json')) {
        setImmediate(() => {
          stdout.emit('data', JSON.stringify({ device: 'r', status: 'busy', currentTask: '编译', tmuxSession: '0' }) + '\n')
          setImmediate(() => { for (const cb of exitCbs) cb(0) })
        })
      } else {
        setImmediate(() => {
          stdout.emit('data', '\n')
          setImmediate(() => { for (const cb of exitCbs) cb(0) })
        })
      }
      return proc
    })
    const { attachToRemote } = await import('../link.ts')
    const r1 = await attachToRemote(DEV, 'hi')
    expect(r1.ok).toBe(false)
    expect(r1.detail).toContain('正在执行任务')
    const r2 = await attachToRemote(DEV, 'hi', '0', true)
    expect(r2.ok).toBe(true)
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
