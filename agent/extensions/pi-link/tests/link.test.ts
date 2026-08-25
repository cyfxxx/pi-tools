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
    markSendStart(key)
    const r = checkConcurrentAndDedup(key, 'm2')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('已有进行中')
    markSendEnd(key)
    expect(checkConcurrentAndDedup(key, 'm2').ok).toBe(true)
  })

  it('窗口内相同消息去重；不同消息放行（指纹仅在成功后写入，2026-08-25 审计 MEDIUM）', async () => {
    const { checkConcurrentAndDedup, markSendStart, markSendSuccess, markSendEnd } = await import('../link.ts')
    const key = 'a@b:22'
    // 失败路径：start→end 无 success——不写指纹，重发同消息应放行（回归：修复前被误拒）
    markSendStart(key)
    markSendEnd(key)
    expect(checkConcurrentAndDedup(key, '重复消息').ok).toBe(true)
    // 成功路径：写指纹后同消息去重、不同消息放行
    markSendStart(key)
    markSendSuccess(key, '重复消息')
    markSendEnd(key) // 发送完成：in-flight 清除，hash 记录保留
    const r1 = checkConcurrentAndDedup(key, '重复消息')
    expect(r1.ok).toBe(false)
    expect(r1.detail).toContain('去重')
    expect(checkConcurrentAndDedup(key, '另一个消息').ok).toBe(true)
  })

  it('窗口过期后同消息放行', async () => {
    vi.useFakeTimers()
    try {
      const { checkConcurrentAndDedup, markSendStart, markSendSuccess, markSendEnd } = await import('../link.ts')
      const key = 'a@b:22'
      markSendStart(key)
      markSendSuccess(key, 'x')
      markSendEnd(key)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000)
      expect(checkConcurrentAndDedup(key, 'x').ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sendToDevice: ssh spawn error 时返回错误且不挂起', async () => {
    spawnMock.mockImplementation(() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      const proc = {
        stdin, stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (e?: unknown) => void) => {
          if (ev === 'error') errorCbs.push(cb)
          if (ev === 'exit') exitCbs.push(cb)
        },
      }
      const errorCbs: Array<(e?: unknown) => void> = []
      const exitCbs: Array<(c: number) => void> = []
      setImmediate(() => { for (const cb of errorCbs) cb(new Error('ssh not found')) })
      return proc
    })
    const { sendToDevice } = await import('../link.ts')
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 5 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ssh 启动失败')
    // 锁已释放：后续调用不受影响
    const { checkConcurrentAndDedup } = await import('../link.ts')
    expect(checkConcurrentAndDedup('testuser@100.64.0.1:2222', 'hi2').ok).toBe(true)
  })

  it('sendToDevice 直接返回拒绝（不 spawn）', async () => {
    spawnMock.mockImplementation(() => { throw new Error('不应 spawn') })
    const { sendToDevice } = await import('../link.ts')
    const key = 'testuser@100.64.0.1:2222'
    markSendStartFor(key)
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已有进行中')
  })
})

// 辅助：直接置 in-flight（sendToDevice 内部函数不可直接调用时用）
import { markSendStart as markSendStartFor } from '../link.ts'

describe('pi-link: buildRemoteCommand', () => {
  it('默认 --no-extensions + 默认 session dir + LD_PRELOAD 清除', () => {
    const cmd = buildRemoteCommand(DEV, {})
    expect(cmd.startsWith('unset LD_PRELOAD 2>/dev/null;')).toBe(true)
    expect(cmd).toContain('--mode rpc --no-extensions --session-dir \'~/.pi/agent/sessions/pi-link\'')
    // 绕过 wrapper：node + 真实 cli.js 优先
    expect(cmd).toContain('readlink -f')
    expect(cmd).toContain('command -v pi-original')
  })

  it('会话连续性：continue 策略含上次会话探测，fresh 策略无', () => {
    const cont = buildRemoteCommand(DEV, {})
    expect(cont).toContain('PI_LINK_LAST_SESSION')
    expect(cont).toContain("SDIR=$HOME'/.pi/agent/sessions/pi-link'")
    expect(cont).toContain('ls -t "$SDIR"/*.jsonl')
    const fresh = buildRemoteCommand(DEV, { sessionPolicy: 'fresh' })
    expect(fresh).not.toContain('PI_LINK_LAST_SESSION')
  })
  it('extensions 开启时省略 --no-extensions', () => {
    expect(buildRemoteCommand(DEV, { extensions: true })).toContain('pi --mode rpc')
    expect(buildRemoteCommand(DEV, { extensions: true })).not.toContain('--no-extensions')
  })
  it('cwd 包装为 cd 前缀', () => {
    // ~ 展开为 $HOME（修复：经 CDIR 变量 + 单引号包裹）
    expect(buildRemoteCommand(DEV, { cwd: '~/work' })).toContain("CDIR=$HOME'/work'; cd \"$CDIR\" && unset LD_PRELOAD")
  })
  it('自定义 sessionDir', () => {
    // 引号保护：sessionDir 含空格/元字符时单引号包裹防远端注入
    expect(buildRemoteCommand(DEV, { sessionDir: '/tmp/x' })).toContain("--session-dir '/tmp/x'")
  })
  it('审计 HIGH 修复：sessionDir/cwd 注入向量被单引号包裹（不落地可执行）', () => {
    const evil = `$(touch /tmp/pi-link-pwned)`
    const c1 = buildRemoteCommand(DEV, { sessionDir: evil })
    // 单引号包裹：$(...) 为字面量，不被命令替换
    expect(c1).toContain(`--session-dir '$(touch /tmp/pi-link-pwned)'`)
    expect(c1).toContain(`SDIR='$(touch /tmp/pi-link-pwned)'`)
    // 反引号 + 分号向量：cwd 原会在双引号内被命令替换，现单引号字面
    const c2 = buildRemoteCommand(DEV, { cwd: 'x`id`;y' })
    expect(c2).toContain("CDIR='x`id`;y'")
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

  it('自定义 sshArgs（如 -i 密钥）透传到发送链路与 remoteExec（审计 MEDIUM：此前 remoteExecAddr 遗漏致 watch/inbox 静默失败）', async () => {
    const dev = { ...DEV, sshArgs: ['-i', '/root/.ssh/id_ed25519'] }
    spawnMock.mockImplementation(() => fakeProc([
      { type: 'tool_execution_end' },
      { type: 'turn_end' },
      { type: 'agent_settled' },
    ]))
    const r = await sendToDevice(dev, 'hello', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    // 发送链路：sshArgs 已透传到 spawn args（calls 跨测试累积，取最后一条）
    const args = spawnMock.mock.calls.at(-1)![1] as string[]
    expect(args.join(' ')).toContain('-i /root/.ssh/id_ed25519')
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

  it('远程中途崩溃（未收到 agent_settled）但有部分回复时返回 truncated 而非假成功', async () => {
    // fakeProc 事件流不含 agent_settled：stdout end + exit 后 settled 仍为 false
    spawnMock.mockImplementation(() => fakeProc([], { reply: '部分回复' }))
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.truncated).toBe(true)
    expect(r.error).toContain('未收到完成确认')
    // 部分回复带回，不静默丢弃
    expect(r.reply).toBe('部分回复')
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
        } else if (cmd.includes('display-message')) {
          // 光标在输入框占位行（空输入框）——第 5 行（1 起）
          stdout.emit('data', '4\n')
        } else if (cmd.includes('capture-pane')) {
          // 空输入框：分隔线 + ~ + 状态栏（无内容行），光标行=~ 行
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

  it('attachToRemote: 消息自动加身份前缀；已有前缀不重复', async () => {
    let pasted = ''
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
      setImmediate(() => {
        if (cmd.includes('pi-link-state.json')) {
          stdout.emit('data', JSON.stringify({ device: 'r', status: 'idle', tmuxSession: '0' }) + '\n')
        } else if (cmd.includes('paste-buffer')) {
          // 原子命令（探测+粘贴）：提取 base64 内容验证前缀，输出空（无 busy 标记）
          const m = cmd.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)
          if (m) pasted = Buffer.from(m[1], 'base64').toString('utf-8')
          stdout.emit('data', '\n')
        } else {
          stdout.emit('data', '\n')
        }
        setImmediate(() => { for (const cb of exitCbs) cb(0) })
      })
      return proc
    })
    const { attachToRemote } = await import('../link.ts')
    await attachToRemote(DEV, '你好', '0', false, 'termux-ubuntu')
    expect(pasted).toContain('[来自 termux-ubuntu] 你好')
    // 已有前缀不重复
    await attachToRemote(DEV, '[来自 x] 你好', '0', false, 'termux-ubuntu')
    expect(pasted).toBe('[来自 x] 你好')
  })

  it('attachToRemote: 并发同设备串行化（不拼接）；buffer 名唯一', async () => {
    const pasted: string[] = []
    const bufs: string[] = []
    let inFlight = 0
    let maxInFlight = 0
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
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setImmediate(() => {
        if (cmd.includes('pi-link-state.json')) {
          stdout.emit('data', JSON.stringify({ device: 'r', status: 'idle', tmuxSession: '0' }) + '\n')
        } else if (cmd.includes('paste-buffer')) {
          const m = cmd.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)
          if (m) pasted.push(Buffer.from(m[1], 'base64').toString('utf-8'))
          const b = cmd.match(/load-buffer -b ([\w-]+)/)
          if (b) bufs.push(b[1])
          stdout.emit('data', '\n')
        } else {
          stdout.emit('data', '\n')
        }
        setImmediate(() => { inFlight--; for (const cb of exitCbs) cb(0) })
      })
      return proc
    })
    const { attachToRemote } = await import('../link.ts')
    const results = await Promise.all([
      attachToRemote(DEV, '甲消息', '0', false, 'termux-ubuntu'),
      attachToRemote(DEV, '乙消息', '0', false, 'termux-ubuntu'),
    ])
    // 串行化：任意时刻只有 1 个 ssh 在途
    expect(maxInFlight).toBeLessThanOrEqual(1)
    // 两条消息各自完整独立（无拼接）
    expect(pasted.filter(x => x.includes('甲消息'))).toHaveLength(1)
    expect(pasted.filter(x => x.includes('乙消息'))).toHaveLength(1)
    // buffer 名唯一（互不覆盖）
    expect(new Set(bufs).size).toBe(bufs.length)
    expect(results.every(r => r.ok)).toBe(true)
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

describe('pi-link: 多地址 failover (altHosts)', () => {
  // probeAddr/remoteExec 用简单 proc（无需事件流）：stdout/stderr/stdin + exit 回调
  function simpleProc({ exitCode = 255, out = '', err = '' } = {}) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const exitCbs: Array<(c: number) => void> = []
    const proc: any = {
      stdin, stdout, stderr,
      kill: vi.fn(),
      on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
    }
    if (out) setImmediate(() => { stdout.emit('data', out) })
    if (err) setImmediate(() => { stderr.emit('data', err) })
    setImmediate(() => { for (const cb of exitCbs) cb(exitCode) })
    return proc
  }

  it('probeDevice 主地址失败后尝试备用地址', async () => {
    spawnMock.mockReset()
    const { probeDevice } = await import('../link')
    spawnMock.mockImplementationOnce(() => simpleProc({ exitCode: 255, err: 'connect refused' }))
    spawnMock.mockImplementationOnce(() => simpleProc({ exitCode: 0, out: 'pi-link-ok\n' }))
    const dev: DeviceConfig = { host: '10.0.0.1', user: 'u', port: 22, altHosts: [{ host: '10.0.0.2', port: 22 }] }
    const r = await probeDevice(dev)
    expect(r.ok).toBe(true)
    // 第一次 spawn 用主地址，第二次用备用（args 为第 2 个参数）
    const calls = spawnMock.mock.calls.map((c: unknown[]) => c[1] as string[])
    expect(calls[0]).toContain('u@10.0.0.1')
    expect(calls[1]).toContain('u@10.0.0.2')
  })

  it('probeAddr spawn 失败（ENOENT 只发 error 不发 exit）不挂起', async () => {
    spawnMock.mockReset()
    const { probeDevice } = await import('../link')
    // 模拟 spawn 同步失败：只发 error、永不发 exit（未修复时会永久挂起直至测试超时）
    spawnMock.mockImplementation(() => {
      const proc: any = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        on: (ev: string, cb: (c?: unknown) => void) => {
          if (ev === 'error') setImmediate(() => cb(new Error('spawn ssh ENOENT')))
        },
      }
      return proc
    })
    const dev: DeviceConfig = { host: '10.0.0.1', user: 'u', port: 22 }
    const r = await probeDevice(dev)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ENOENT')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('probeDevice 全部地址失败返回不可达', async () => {
    spawnMock.mockReset()
    const { probeDevice } = await import('../link')
    spawnMock.mockImplementation(() => simpleProc({ exitCode: 255, err: 'refused' }))
    const dev: DeviceConfig = { host: '10.0.0.1', user: 'u', altHosts: [{ host: '10.0.0.2' }] }
    const r = await probeDevice(dev)
    expect(r.ok).toBe(false)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('remoteExec 主地址失败换备用，全部失败返回最后错误', async () => {
    spawnMock.mockReset()
    const { remoteExec } = await import('../link')
    spawnMock.mockImplementation(() => simpleProc({ exitCode: 255, err: 'refused' }))
    const dev: DeviceConfig = { host: '10.0.0.1', user: 'u', altHosts: [{ host: '10.0.0.2' }] }
    const r = await remoteExec(dev, 'echo hi', 3000)
    expect(r.code).not.toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('deviceAddresses 主地址优先 + 备用按序', async () => {
    const { deviceAddresses } = await import('../config')
    const dev: DeviceConfig = { host: 'a', user: 'u', altHosts: [{ host: 'b' }, { host: 'c', port: 33 }] }
    const addrs = deviceAddresses(dev)
    expect(addrs).toEqual([{ host: 'a', port: undefined }, { host: 'b' }, { host: 'c', port: 33 }])
    expect(deviceAddresses({ host: 'x', user: 'u' })).toEqual([{ host: 'x', port: undefined }])
  })
})

// 审计回归：events 全量数组无界累积致长任务内存膨胀——改边收边聚合后统计语义不变。
// 注意：本文件所有用例统一走顶部 hoisted 的 spawnMock（beforeEach 里的 vi.doMock
// 对已缓存模块不生效，历史遗留死代码），此处直接 mockImplementation 即可。
describe('pi-link: 边收边聚合（events 无界累积回归）', () => {
  beforeEach(() => {
    resetSendGuards()
    spawnMock.mockReset()
  })

  function fakeStream(lines: Array<Record<string, unknown>>) {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = new PassThrough()
    const exitCbs: Array<(c: number) => void> = []
    const proc = {
      stdin, stdout, stderr,
      kill: vi.fn(),
      on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
    }
    stdin.on('data', () => {
      setImmediate(() => {
        for (const l of lines) stdout.emit('data', JSON.stringify(l) + '\n')
        setImmediate(() => {
          stdout.emit('end')
          for (const cb of exitCbs) cb(0)
        })
      })
    })
    return proc
  }

  it('数千事件下 turns/tools/reply 统计与旧全量数组语义一致', async () => {
    const lines: Array<Record<string, unknown>> = []
    for (let i = 0; i < 3000; i++) {
      lines.push({ type: 'tool_execution_end' })
      if (i % 1000 === 0) {
        lines.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `中间回复${i}` }] } })
        lines.push({ type: 'turn_end' })
      }
    }
    // 最后一条 assistant 只含 toolCall+文本块：reply 取其文本、model 更新为 m-final
    lines.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'x' }, { type: 'text', text: '最终回复' }], model: 'm-final' } })
    lines.push({ type: 'turn_end' })
    lines.push({ type: 'agent_settled' })
    spawnMock.mockImplementation(() => fakeStream(lines))
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(true)
    expect(r.tools).toBe(3000)
    expect(r.turns).toBe(4)
    expect(r.reply).toBe('最终回复')
    expect(r.model).toBe('m-final')
  })

  it('无 assistant 文本时 reply 为空（聚合不误报）', async () => {
    spawnMock.mockImplementation(() => fakeStream([{ type: 'agent_settled' }]))
    const r = await sendToDevice(DEV, 'hi', { timeoutSec: 30 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('远程未返回文本回复')
  })
})

// 审计回归：switch_session 20s 超时后照发 prompt 违反"必须等 response"不变量——
// 超时按失败处理（弃 lastSession 走新会话路径），不发 prompt 进旧会话
describe('pi-link: switch_session 超时按失败处理', () => {
  const stdinWrites: string[] = []
  beforeEach(() => {
    resetSendGuards()
    spawnMock.mockReset()
    stdinWrites.length = 0
  })

  it('switch 20s 超时（无 response）→ 弃旧会话，prompt 延后到超时后才发出且 resumed=false', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = new PassThrough()
      const exitCbs: Array<(c: number) => void> = []
      const proc = {
        stdin, stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
      }
      stdin.on('data', (chunk: Buffer) => {
        stdinWrites.push(chunk.toString())
        if (chunk.toString().includes('"type":"prompt"')) {
          // 新会话路径正常完成（assistant 回复 + agent_settled）
          setImmediate(() => {
            stdout.emit('data', JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '新会话回复' }] } }) + '\n')
            stdout.emit('data', JSON.stringify({ type: 'agent_settled' }) + '\n')
            setImmediate(() => { stdout.emit('end'); for (const cb of exitCbs) cb(0) })
          })
        }
        // switch_session 永不回 response——模拟远程无响应直至 20s 超时
      })
      spawnMock.mockImplementation(() => {
        setImmediate(() => stdout.emit('data', 'PI_LINK_LAST_SESSION=/root/.pi/agent/sessions/pi-link/stale.jsonl\n'))
        return proc
      })
      const pending = sendToDevice(DEV, 'hi', { timeoutSec: 30 })
      // 握手行已消费、switch 已写出；此刻必须还没有 prompt（等待 response 的不变量）
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      expect(stdinWrites.join('')).toContain('"type":"switch_session"')
      expect(stdinWrites.join('')).not.toContain('"type":"prompt"')
      // 推进 20s 触发 switch 超时 → 按失败处理 → prompt 走新会话路径
      await vi.advanceTimersByTimeAsync(20000)
      const r = await pending
      expect(r.ok).toBe(true)
      expect(r.reply).toBe('新会话回复')
      // 关键断言：超时标记为失败——修复前 resumed=true 且不等 response 照发 prompt
      expect(r.resumed).toBe(false)
      expect(stdinWrites.join('')).toContain('"type":"prompt"')
      expect(stdinWrites.filter((w) => w.includes('switch_session'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
