/**
 * 审计修复（2026-08-26）回归：注册表并发安全
 * - saveRegistry：tmp+rename 原子替换（写失败不留残缺主文件、无 tmp 残留）
 * - registerSession/unregisterSession：写前重读磁盘，仅应用本条目变更（他实例条目以磁盘为准）
 * - pruneRegistry：存活校验（秒级耗时）期间他实例新注册的条目不被陈旧快照覆盖
 *
 * tmux 交互走 child_process.execFile mock（-V 探测成功 / has-session 按名单返回），
 * 注册表用临时 PI_HOME 隔离，绝不触碰真实 ~/.pi/agent/.pi-tmux-registry.json。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())
const fsState = vi.hoisted(() => ({ failRegistryWrite: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock, spawn: vi.fn() }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realWrite = actual.writeFileSync
  return {
    ...actual,
    // 默认透传；failRegistryWrite=true 时仅对注册表主文件抛错（测原子性：主文件不被残写破坏）
    writeFileSync: (...args: Parameters<typeof realWrite>) => {
      if (fsState.failRegistryWrite && String(args[0]).includes('.pi-tmux-registry.json')) {
        throw new Error('simulated disk full')
      }
      return realWrite(...args)
    },
  }
})

import { loadRegistry, saveRegistry, registerSession, unregisterSession, pruneRegistry, type RegistryEntry } from '../core'

const opts = { bin: 'tmux', logDir: join(tmpdir(), 'pi-tmux-reg-test'), prefix: 'pi-' }
let testHome = ''
let registryFile = ''

function entry(name: string, owner?: string): RegistryEntry {
  // 固定时间戳：调用方多处用 toEqual 全量比较，new Date() 毫秒漂移会假失败
  return { name, logPath: `/tmp/logs/${name}.log`, command: `echo ${name}`, createdAt: '2026-08-28T00:00:00.000Z', ...(owner ? { owner } : {}) }
}

/** 直接写盘模拟“另一实例”的注册表变更（绕过本进程内存；走透传写路径，不受 fail 注入影响） */
function otherInstanceWrite(reg: { sessions: Record<string, RegistryEntry> }): void {
  mkdirSync(dirname(registryFile), { recursive: true })
  writeFileSync(registryFile, JSON.stringify(reg, null, 2), 'utf-8')
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'pi-tmux-reg-home-'))
  process.env.PI_HOME = testHome
  registryFile = join(testHome, 'agent', '.pi-tmux-registry.json')
  execFileMock.mockReset()
  fsState.failRegistryWrite = false
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('saveRegistry 原子替换', () => {
  it('写后主文件内容完整，无 .tmp-* 残留', () => {
    saveRegistry({ sessions: { 'pi-a': entry('pi-a') } })
    expect(JSON.parse(readFileSync(registryFile, 'utf-8'))).toEqual({ sessions: { 'pi-a': entry('pi-a') } })
    const leftovers = readdirSync(join(testHome, 'agent')).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('写入失败 → 主文件旧内容不被破坏（先写 tmp 后 rename）', () => {
    // 预置旧注册表（fail 注入未开启，写透传真实落盘）
    otherInstanceWrite({ sessions: { 'pi-old': entry('pi-old') } })
    fsState.failRegistryWrite = true
    expect(() => saveRegistry({ sessions: {} })).toThrow('simulated disk full')
    // 主文件仍是旧内容（非空/残缺 JSON）
    expect(JSON.parse(readFileSync(registryFile, 'utf-8'))).toEqual({ sessions: { 'pi-old': entry('pi-old') } })
    // tmp 已清理
    expect(readdirSync(join(testHome, 'agent')).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})

describe('register/unregister 并发合并（他实例条目以磁盘为准）', () => {
  it('registerSession 仅新增本条目，磁盘上他实例条目保留', () => {
    otherInstanceWrite({ sessions: { 'pi-other': entry('pi-other', 'other-session') } })
    registerSession(entry('pi-mine', 'my-session'))
    const reg = loadRegistry()
    expect(reg.sessions['pi-other']).toBeDefined()
    expect(reg.sessions['pi-mine']).toBeDefined()
  })

  it('unregisterSession 仅删除目标条目，他实例条目保留', () => {
    otherInstanceWrite({ sessions: { 'pi-other': entry('pi-other', 'other-session'), 'pi-mine': entry('pi-mine', 'my-session') } })
    unregisterSession('pi-mine')
    const reg = loadRegistry()
    expect(reg.sessions['pi-other']).toBeDefined()
    expect(reg.sessions['pi-mine']).toBeUndefined()
  })
})

describe('pruneRegistry 写前重读合并', () => {
  it('存活校验期间他实例新注册的条目不被陈旧快照覆盖（死亡条目移除、存活与他实例新条目保留）', async () => {
    // tmux -V 探测成功；has-session：pi-dead 退出码 1（死亡）、pi-live 退出码 0（存活）
    execFileMock.mockImplementation((_bin: string, args: string[], _o: unknown, cb: (e: Error | null, o?: string, s?: string) => void) => {
      const cmd = args.join(' ')
      if (cmd.startsWith('-V')) { cb(null, 'tmux 3.4', ''); return }
      if (cmd.includes('has-session')) {
        const name = args[args.indexOf('-t') + 1]
        if (name === 'pi-dead') { cb(Object.assign(new Error('can\'t find session'), { code: 1 })); return }
        cb(null, '', '')
        return
      }
      cb(null, '', '')
    })
    // 预置磁盘：dead + live（本实例先看到这两个）
    otherInstanceWrite({ sessions: { 'pi-dead': entry('pi-dead', 'my-session'), 'pi-live': entry('pi-live', 'my-session') } })
    // 模拟并发：在 prune 探测 pi-live（即校验进行中）时，他实例注册 pi-new
    let injected = false
    const origImpl = execFileMock.getMockImplementation()!
    execFileMock.mockImplementation((bin: string, args: string[], o: unknown, cb: Parameters<typeof origImpl>[3]) => {
      if (!injected && args.includes('has-session') && args[args.indexOf('-t') + 1] === 'pi-live') {
        injected = true
        const reg = JSON.parse(readFileSync(registryFile, 'utf-8')) as { sessions: Record<string, RegistryEntry> }
        reg.sessions['pi-new'] = entry('pi-new', 'other-session')
        otherInstanceWrite(reg)
      }
      origImpl(bin, args, o, cb)
    })

    const removed = await pruneRegistry(opts)
    expect(removed).toBe(1)
    const reg = loadRegistry()
    expect(reg.sessions['pi-dead']).toBeUndefined()   // 本实例判定死亡 → 移除
    expect(reg.sessions['pi-live']).toBeDefined()     // 存活 → 保留
    expect(reg.sessions['pi-new']).toBeDefined()      // 审计修复核心：校验期间他实例新注册 → 以磁盘为准保留
  })

  it('tmux 不可用 → 返回 0 且不动注册表', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _o: unknown, cb: (e: Error | null) => void) => {
      cb(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }))
    })
    otherInstanceWrite({ sessions: { 'pi-x': entry('pi-x') } })
    expect(await pruneRegistry(opts)).toBe(0)
    expect(loadRegistry().sessions['pi-x']).toBeDefined()
  })
})
