// 审计 LOW 回归：readOutput 日志读取竞态（existsSync 与 open/read 之间文件被删）
// 与 waitSession exited 分支补读尾部。node:fs 部分模拟（fail 标志穿透到实际实现），
// 不影响其他 fs 功能；集成用例沿用"无 tmux 自动跳过"守卫。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const race = vi.hoisted(() => ({ failTail: false, failFullRead: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const enoent = (): never => {
    const e = new Error('ENOENT: no such file or directory, open (race-simulated)') as NodeJS.ErrnoException
    e.code = 'ENOENT'
    throw e
  }
  return {
    ...actual,
    openSync(...args: Parameters<typeof actual.openSync>) {
      if (race.failTail) enoent()
      return actual.openSync(...args)
    },
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (race.failFullRead) enoent()
      return actual.readFileSync(...args)
    },
  }
})

import { type TmuxOpts, logPathFor, readOutput } from '../core'

const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-race-test'), prefix: 'pi-' }
const NAME = 'pi-race'

function seedLog(content: string): string {
  mkdirSync(opts.logDir, { recursive: true })
  const p = logPathFor(opts, NAME)
  writeFileSync(p, content)
  return p
}

afterEach(() => {
  race.failTail = false
  race.failFullRead = false
  rmSync(logPathFor(opts, NAME), { force: true })
})

describe('readOutput 日志竞态回退（审计 LOW）', () => {
  it('tail 读与兜底全量读都失败（文件被删）→ 回退 capture-pane，不向外抛错', async () => {
    const log = seedLog('stale-content\n')
    expect(log.length).toBeGreaterThan(0)
    race.failTail = true
    race.failFullRead = true
    const out = await readOutput(opts, NAME, 50)
    // 关键断言：不抛 ENOENT，走 capture 路径（tmux 缺失时 capture-pane 也失败 → 占位文本）
    expect(out.source).toBe('capture')
  })

  it('仅 tail 读失败、兜底全量读成功 → 仍按 log 源返回内容（既有行为保持）', async () => {
    seedLog('line-1\nline-2\n')
    race.failTail = true
    race.failFullRead = false
    const out = await readOutput(opts, NAME, 50)
    expect(out.source).toBe('log')
    expect(out.text).toContain('line-2')
  })

  it('无注入时正常读 log（mock 透传不破坏既有路径）', async () => {
    seedLog('hello-tail\n')
    const out = await readOutput(opts, NAME, 50)
    expect(out.source).toBe('log')
    expect(out.text).toContain('hello-tail')
  })
})

// 集成：waitSession exited 分支补读日志尾部（需真实 tmux；缺失自动跳过）
describe('waitSession exited 分支补读尾部（集成）', () => {
  it('pattern 在退出前写入且循环未读过日志时，exited 结果仍携带该输出', async () => { // eslint-disable-line
    const { runTmux, startSession, hasSession, killSession, removeLog, waitSession } = await import('../core')
    const avail = await runTmux(opts, ['-V'], 5000)
    if (avail.code === 127) {
      expect(true).toBe(true) // 无 tmux 环境：跳过
      return
    }
    const name = 'pi-wait-exit-marker'
    await killSession(opts, name).catch(() => {})
    await startSession(opts, name, 'echo wait-exit-marker', tmpdir())
    // 等会话自然退出后再调 waitSession——首轮 hasSession 即 false，
    // 复现"pattern 恰在退出前写入、循环从未进入 pattern 读取分支"
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && (await hasSession(opts, name))) {
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(await hasSession(opts, name)).toBe(false)

    const w = await waitSession(opts, name, 'wait-exit-marker', 5000, false)
    expect(w.outcome).toBe('exited')
    // 修复前 lastOutput 为空串 → 此断言失败
    expect(w.lastOutput).toContain('wait-exit-marker')

    removeLog(opts, name)
  }, 30000)
})
