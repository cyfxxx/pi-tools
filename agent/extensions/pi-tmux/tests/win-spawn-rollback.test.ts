// 审计 LOW 回归：Windows 后端 new-session spawn 同步抛错时 winNonInteractive 已 add
// 未回滚 → 同名会话重建后 send-keys 被“无 stdin 交互”误拒。本文件级 mock 拦截 spawn
// 并伪造 process.platform=win32（vitest 文件级隔离，不影响其他测试文件）。
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const ctrl = vi.hoisted(() => ({ throwSync: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((shell: unknown, args: unknown, o: unknown) => {
      if (ctrl.throwSync) throw new Error('sync spawn boom')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.spawn as any)(shell, args, o)
    }) as typeof actual.spawn,
  }
})

import { runTmux, type TmuxOpts } from '../core'

const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-rollback-test'), prefix: 'pi-' }
const NAME = 'pi-rollback'

function fakeChild() {
  return {
    stdin: { write: vi.fn(), destroyed: false },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    unref: vi.fn(),
    pid: 424242,
    kill: vi.fn(),
  }
}

const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterAll(() => {
  if (origPlatform) Object.defineProperty(process, 'platform', origPlatform)
})
afterEach(() => {
  ctrl.throwSync = false
  rmSync(join(opts.logDir, 'pi-rollback.pid'), { force: true })
  rmSync(join(opts.logDir, 'pi-rollback-b.pid'), { force: true })
})

describe('new-session spawn 抛错回滚 winNonInteractive（审计 LOW）', () => {
  it('首次 spawn 同步抛错后，同名会话重建的 send-keys 不被“无 stdin 交互”误拒', async () => {
    // 第一次：带启动命令（进入 non-interactive 分支）但 spawn 同步抛错
    ctrl.throwSync = true
    const r1 = await runTmux(opts, ['new-session', '-d', '-s', NAME, '-c', tmpdir(), 'echo hi'])
    expect(r1.code).toBe(1)
    expect(r1.stderr).toContain('spawn shell failed')

    // 第二次：同名重建成功（交互 shell，无启动命令）
    let child: ReturnType<typeof fakeChild> | undefined
    const spawnMod = (await import('node:child_process')) as unknown as { spawn: () => unknown }
    const realSpawn = spawnMod.spawn
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(spawnMod as any).spawn = () => {
      child = fakeChild()
      return child
    }
    try {
      const r2 = await runTmux(opts, ['new-session', '-d', '-s', NAME, '-c', tmpdir()])
      expect(r2.code).toBe(0)
      expect(child).toBeDefined()

      // 关键断言：send-keys 正常写入（修复前 winNonInteractive 残留标记 → code 1 误拒）
      const r3 = await runTmux(opts, ['send-keys', '-t', NAME, '-l', 'hello'])
      expect(r3.code).toBe(0)
      expect(r3.stderr).not.toContain('无 stdin 交互')
      expect(child!.stdin.write).toHaveBeenCalledWith('hello')
    } finally {
      ;(spawnMod as unknown as { spawn: unknown }).spawn = realSpawn
    }
  })

  it('spawn 成功路径行为不变：non-interactive 会话 send-keys 文本仍被拦截', async () => {
    const B = 'pi-rollback-b' // 独立会话名：winChildren/winNonInteractive 模块态跨测试不重置
    const spawnMod = (await import('node:child_process')) as unknown as { spawn: () => unknown }
    const realSpawn = spawnMod.spawn
    ;(spawnMod as unknown as { spawn: unknown }).spawn = () => fakeChild()
    try {
      const r1 = await runTmux(opts, ['new-session', '-d', '-s', B, '-c', tmpdir(), 'sleep 30'])
      expect(r1.code).toBe(0)
      const r2 = await runTmux(opts, ['send-keys', '-t', B, '-l', 'hi'])
      expect(r2.code).toBe(1)
      expect(r2.stderr).toContain('无 stdin 交互')
    } finally {
      ;(spawnMod as unknown as { spawn: unknown }).spawn = realSpawn
    }
  })
})
