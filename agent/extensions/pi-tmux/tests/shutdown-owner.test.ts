// 审计 MEDIUM 回归：session_shutdown 只杀本会话拥有的后台任务。
// 三态覆盖：owner 匹配 → 杀；owner 属于其他 pi 实例 → 保留并计数跳过；
// owner 空/缺失的旧条目 → 视为公共遗留仍可杀（向后兼容）。
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  shutdownCleanup,
  type Registry,
  type SessionInfo,
  type RegistryEntry,
  type TmuxOpts,
} from '../core'

const opts: TmuxOpts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-shutdown-test'), prefix: 'pi-' }
const SELF = 'session-A'

function makeReg(entries: Array<Partial<RegistryEntry> & { name: string }>): Registry {
  return {
    sessions: Object.fromEntries(
      entries.map((e) => [e.name, { logPath: '', command: '', createdAt: '', ...e } as RegistryEntry]),
    ),
  }
}

function sess(...names: string[]): SessionInfo[] {
  return names.map((name) => ({ name, attached: false }))
}

describe('shutdownCleanup owner 过滤（审计 MEDIUM）', () => {
  it('owner===当前会话 → 杀掉', async () => {
    const calls: string[] = []
    const reg = makeReg([{ name: 'pi-mine', owner: SELF }])
    const r = await shutdownCleanup(opts, reg, sess('pi-mine'), 'pi-', SELF, async (_o, n) => { calls.push(n) })
    expect(r.killed).toEqual(['pi-mine'])
    expect(r.skippedOthers).toEqual([])
    expect(calls).toEqual(['pi-mine'])
  })

  it('owner 为其他 pi 实例 → 不杀、计入 skippedOthers', async () => {
    const calls: string[] = []
    const reg = makeReg([{ name: 'pi-theirs', owner: 'session-B' }])
    const r = await shutdownCleanup(opts, reg, sess('pi-theirs'), 'pi-', SELF, async (_o, n) => { calls.push(n) })
    expect(r.killed).toEqual([])
    expect(r.skippedOthers).toEqual(['pi-theirs'])
    expect(calls).toEqual([])
  })

  it('空 owner / 缺失 owner 的旧条目 → 视为公共仍可杀（向后兼容）', async () => {
    const calls: string[] = []
    const reg = makeReg([
      { name: 'pi-legacy-empty', owner: '' },
      { name: 'pi-legacy-none' }, // 无 owner 字段
      { name: 'pi-other', owner: 'session-B' },
    ])
    const r = await shutdownCleanup(
      opts, reg,
      sess('pi-legacy-empty', 'pi-legacy-none', 'pi-other'),
      'pi-', SELF,
      async (_o, n) => { calls.push(n) },
    )
    expect(r.killed.sort()).toEqual(['pi-legacy-empty', 'pi-legacy-none'])
    expect(r.skippedOthers).toEqual(['pi-other'])
    expect(calls.sort()).toEqual(['pi-legacy-empty', 'pi-legacy-none'])
  })

  it('非 pi- 前缀或不在注册表中的会话 → 不碰也不计跳过', async () => {
    const calls: string[] = []
    const reg = makeReg([{ name: 'pi-mine', owner: SELF }])
    const r = await shutdownCleanup(
      opts, reg,
      sess('user-session', 'pi-unregistered', 'pi-mine'),
      'pi-', SELF,
      async (_o, n) => { calls.push(n) },
    )
    expect(r.killed).toEqual(['pi-mine'])
    expect(r.skippedOthers).toEqual([])
    expect(calls).toEqual(['pi-mine'])
  })

  it('kill 单个抛错不中断其余清理', async () => {
    const calls: string[] = []
    const reg = makeReg([
      { name: 'pi-a', owner: SELF },
      { name: 'pi-b', owner: '' },
    ])
    const r = await shutdownCleanup(
      opts, reg, sess('pi-a', 'pi-b'), 'pi-', SELF,
      async (_o, n) => {
        calls.push(n)
        if (n === 'pi-a') throw new Error('boom')
      },
    )
    expect(r.killed).toEqual(['pi-b'])
    expect(calls).toEqual(['pi-a', 'pi-b'])
  })
})
