import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type TmuxOpts,
  normalizeSessionName,
  isPiSession,
  logPathFor,
  defaultOpts,
} from '../core'
import { resolveName, registerTmuxTools } from '../tools'

// 纯函数测试：命名规范化、前缀判定、日志路径
describe('pi-tmux core 纯函数', () => {
  const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-test'), prefix: 'pi-' }

  it('normalizeSessionName 强制 pi- 前缀', () => {
    expect(normalizeSessionName('build', 'pi-')).toBe('pi-build')
    expect(normalizeSessionName('pi-build', 'pi-')).toBe('pi-build')
    expect(normalizeSessionName('  dev-server  ', 'pi-')).toBe('pi-dev-server')
  })

  it('normalizeSessionName 拒绝非法字符', () => {
    expect(() => normalizeSessionName('bad name', 'pi-')).toThrow(/非法/)
    expect(() => normalizeSessionName('a;rm', 'pi-')).toThrow(/非法/)
    expect(() => normalizeSessionName('', 'pi-')).toThrow(/为空/)
    expect(() => normalizeSessionName('x'.repeat(50), 'pi-')).toThrow(/非法/)
  })

  it('isPiSession 判定前缀', () => {
    expect(isPiSession('pi-build', 'pi-')).toBe(true)
    expect(isPiSession('main', 'pi-')).toBe(false)
  })

  it('logPathFor 指向日志目录', () => {
    expect(logPathFor(opts, 'pi-build')).toBe(join(tmpdir(), 'pi-tmux-test', 'pi-build.log'))
  })

  it('defaultOpts 使用 PI_HOME 覆盖', () => {
    const prev = process.env.PI_HOME
    process.env.PI_HOME = join(tmpdir(), 'pihome')
    const d = defaultOpts()
    expect(d.logDir).toBe(join(process.env.PI_HOME!, 'logs', 'tmux'))
    expect(d.prefix).toBe('pi-')
    if (prev === undefined) delete process.env.PI_HOME
    else process.env.PI_HOME = prev
  })
})

// 工具层会话名校验：resolveName 委托 normalizeSessionName，堵路径穿越
//（tmux_stop remove_log 删任意 .log / tmux_read 读任意 .log 同根）
describe('pi-tmux tools resolveName 会话名安全', () => {
  const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-tools-test'), prefix: 'pi-' }

  it('合法名自动加前缀（含已带前缀）', () => {
    expect(resolveName({ name: 'build' }, 'pi-')).toBe('pi-build')
    expect(resolveName({ name: 'pi-build' }, 'pi-')).toBe('pi-build')
    expect(resolveName({ name: '  dev-server  ' }, 'pi-')).toBe('pi-dev-server')
  })

  it('拒绝路径穿越与空名', () => {
    expect(() => resolveName({ name: '../etc/passwd' }, 'pi-')).toThrow(/非法/)
    expect(() => resolveName({ name: '../../secret' }, 'pi-')).toThrow(/非法/)
    expect(() => resolveName({ name: 'a/b' }, 'pi-')).toThrow(/非法/)
    expect(() => resolveName({ name: '' }, 'pi-')).toThrow(/为空/)
    expect(() => resolveName({ name: '   ' }, 'pi-')).toThrow(/为空/)
  })

  it('tmux_stop/tmux_read 对非法名直接 err 返回（不触达 tmux/文件系统）', async () => {
    const { runTmux } = await import('../core')
    const avail = await runTmux(opts, ['-V'], 5000)
    if (avail.code === 127) return // 无 tmux 环境：跳过（纯逻辑用例已覆盖校验）

    const tools: Record<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }> }> = {}
    const pi = { registerTool: (t: { name: string; execute: unknown }) => { tools[t.name] = t as never } }
    registerTmuxTools(pi as never, {
      bin: 'tmux',
      prefix: 'pi-',
      logDir: opts.logDir,
      defaultLines: 100,
      defaultTimeoutSec: 60,
    })
    const stopRes = await tools.tmux_stop.execute('id', { name: '../evil', remove_log: true })
    expect(stopRes.isError).toBe(true)
    expect(stopRes.content[0].text).toContain('非法会话名')
    const readRes = await tools.tmux_read.execute('id', { name: 'x/y' })
    expect(readRes.isError).toBe(true)
    expect(readRes.content[0].text).toContain('非法会话名')
    const okRes = await tools.tmux_read.execute('id', { name: 'nonexistent' })
    expect(okRes.isError).toBeUndefined()
  })
})

// 集成类：真正调用 tmux（若环境无 tmux 则自动跳过）
// Windows 后端安全：会话名 NAME_RE 校验（路径穿越防护）
// Windows 后端（winSessionName 校验）仅 win32 生效——非 Windows 平台跳过
const isWin32 = process.platform === 'win32'

describe('pi-tmux Windows 后端会话名校验', () => {
  const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-test'), prefix: 'pi-' }

  it('winSessionName 拒绝路径穿越名（../../x 等）', { skip: !isWin32 }, async () => {
    const { runTmux } = await import('../core')
    // 非法名 → 不进入 pidfile/taskkill（kill-session 报错而非操作文件）
    for (const name of ['../../x', 'pi-../evil', 'pi-x/y', 'pi-%2e%2e']) {
      const r = await runTmux(opts, ['kill-session', '-t', name], 5000)
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/非法/)
      const h = await runTmux(opts, ['has-session', '-t', name], 5000)
      expect(h.code).toBe(1)
    }
  })

  it('winSessionName 接受正常名（pi- 前缀）', { skip: !isWin32 }, async () => {
    const { runTmux } = await import('../core')
    const h = await runTmux(opts, ['has-session', '-t', 'pi-valid'], 5000)
    expect(h.code).toBe(1) // 会话不存在（非非法名报错）
    expect(h.stderr).not.toMatch(/非法/)
  })
})


describe('pi-tmux 真实 tmux 会话（环境具备 tmux 时）', () => {
  const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-integration'), prefix: 'pi-' }
  const testSession = 'pi-vitest-integration'

  beforeEach(() => {})
  afterEach(() => {})

  it('tmux 可用性检测（跳过机制）', async () => {
    const { runTmux } = await import('../core')
    const r = await runTmux(opts, ['-V'], 5000)
    if (r.code === 127) {
      // 无 tmux 环境：跳过集成测试
      expect(true).toBe(true)
      return
    }
    expect(r.code).toBe(0)
  })

  it('完整生命周期：创建 → 输出 → 交互 → 结束', async () => {
    const { runTmux } = await import('../core')
    const avail = await runTmux(opts, ['-V'], 5000)
    if (avail.code === 127) return

    const {
      startSession, readOutput, sendKeys, hasSession, killSession, waitSession, removeLog,
    } = await import('../core')

    // 清理可能的残留
    await killSession(opts, testSession).catch(() => {})

    const started = await startSession(opts, 'vitest-integration', 'echo tmux-hello-123 && sleep 5', tmpdir())
    expect(started.started).toBe(true)
    expect(started.name).toBe(testSession)

    // 输出落盘
    await new Promise((r) => setTimeout(r, 800))
    const out = await readOutput(opts, testSession, 100)
    expect(out.source).toBe('log')
    expect(out.text).toContain('tmux-hello-123')

    // 会话存活
    expect(await hasSession(opts, testSession)).toBe(true)

    // send-keys 交互（Windows 原生后端：bash -c 会话无 stdin 交互——仅 Ctrl-C 可用，跳过文本注入）
    if (process.platform !== 'win32') {
      await sendKeys(opts, testSession, { ctrlKey: 'c' })
      await new Promise((r) => setTimeout(r, 500))
      await sendKeys(opts, testSession, { text: 'echo after-ctrl-c', enter: true })
      await new Promise((r) => setTimeout(r, 800))
      const out2 = await readOutput(opts, testSession, 100)
      expect(out2.text).toContain('after-ctrl-c')
    } else {
      await sendKeys(opts, testSession, { ctrlKey: 'c' })
    }

    // wait 超时（会话 sleep 已结束/被打断）
    const w = await waitSession(opts, testSession, undefined, 3000, true)
    expect(['exited', 'timeout']).toContain(w.outcome)

    // 结束 + 日志删除
    await killSession(opts, testSession)
    expect(await hasSession(opts, testSession)).toBe(false)
    removeLog(opts, testSession)
  }, 30000)
})
