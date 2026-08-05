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

// 集成类：真正调用 tmux（若环境无 tmux 则自动跳过）
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

    // send-keys 交互
    await sendKeys(opts, testSession, { ctrlKey: 'c' })
    await new Promise((r) => setTimeout(r, 500))
    await sendKeys(opts, testSession, { text: 'echo after-ctrl-c', enter: true })
    await new Promise((r) => setTimeout(r, 800))
    const out2 = await readOutput(opts, testSession, 100)
    expect(out2.text).toContain('after-ctrl-c')

    // wait 超时（会话 sleep 已结束/被打断）
    const w = await waitSession(opts, testSession, undefined, 3000, true)
    expect(['exited', 'timeout']).toContain(w.outcome)

    // 结束 + 日志删除
    await killSession(opts, testSession)
    expect(await hasSession(opts, testSession)).toBe(false)
    removeLog(opts, testSession)
  }, 30000)
})
