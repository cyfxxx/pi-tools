import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeLocalState, localStateFilePath, type LocalState } from '../state-writer.ts'
import { writeActive, activeFilePath, readActive } from '../active.ts'

let dir: string

const readState = (): Partial<LocalState> => JSON.parse(readFileSync(localStateFilePath(), 'utf-8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-link-state-'))
  process.env.PI_LINK_STATE_DIR = dir
})

afterEach(() => {
  delete process.env.PI_LINK_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

// 审计：idle 回写不清 currentTask 致陈旧任务名一直展示（远程 watch/attach 看到
// 早已结束的任务）。partial 无 currentTask 且状态为 idle 时显式置 undefined。
describe('pi-link state-writer: idle 清除 currentTask', () => {
  it('idle 回写无 currentTask 时清掉陈旧值（回归：修复前一直残留）', () => {
    writeLocalState({ device: 'me', status: 'busy', currentTask: '编译内核' })
    expect(readState().currentTask).toBe('编译内核')
    writeLocalState({ device: 'me', status: 'idle' })
    const s = readState()
    expect(s.status).toBe('idle')
    expect(s.currentTask).toBeUndefined()
    // 显式置 undefined → JSON 序列化时省略该键
    expect('currentTask' in s).toBe(false)
  })

  it('busy 回写无 currentTask 时保留旧任务名（同一任务运行中，语义不变）', () => {
    writeLocalState({ device: 'me', status: 'busy', currentTask: '跑测试' })
    writeLocalState({ device: 'me', status: 'busy' })
    const s = readState()
    expect(s.status).toBe('busy')
    expect(s.currentTask).toBe('跑测试')
  })

  it('idle 回写显式带 currentTask 时尊重传入值；其余字段照常合并', () => {
    writeLocalState({ device: 'me', status: 'busy', tmuxSession: '0' })
    writeLocalState({ status: 'idle', currentTask: '收尾清理' })
    const s = readState()
    expect(s.currentTask).toBe('收尾清理')
    expect(s.device).toBe('me')
    expect(s.tmuxSession).toBe('0')
  })

  it('首次写入（无旧文件）idle 无 currentTask 不报错', () => {
    writeLocalState({ device: 'fresh', status: 'idle' })
    const s = readState()
    expect(s.device).toBe('fresh')
    expect(s.status).toBe('idle')
    expect('currentTask' in s).toBe(false)
  })
})

// 审计 MEDIUM（2026-08-26）：writeLocalState/writeActive 无锁 read-merge-write——
// 多实例并发互相覆盖丢更新。修复：同目录 .lock（O_EXCL）互斥，自旋 ≤500ms，陈锁强制接管。
import { writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('pi-link state-writer: .lock 并发互斥（审计修复）', () => {
  it('另一进程持锁时写入等待至释放，更新不丢失（真实跨进程竞争）', async () => {
    const file = localStateFilePath()
    const lockPath = `${file}.lock`
    // 子进程：立即持锁，300ms 后释放退出（独立进程，父进程同步自旋期间它可运行）
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      fs.writeFileSync(process.env.LOCK_PATH, String(process.pid));
      setTimeout(() => { try { fs.unlinkSync(process.env.LOCK_PATH); } catch {} }, 300);
    `], { env: { ...process.env, LOCK_PATH: lockPath }, stdio: 'ignore' })
    child.unref()
    await sleep(100) // 等子进程建锁
    expect(existsSync(lockPath)).toBe(true)

    writeLocalState({ device: 'me', status: 'busy', tmuxSession: 'remote-sess' })
    // 修复前：无锁直接覆盖（模拟竞争会丢对方更新）；修复后：等待 ≤500ms 拿锁后写入
    const s = readState()
    expect(s.tmuxSession).toBe('remote-sess')
    expect(existsSync(lockPath)).toBe(false) // 写完释放
  }, 10000)

  it('陈锁（持有者死亡未清理）超时强制接管，不永久阻塞', async () => {
    const file = localStateFilePath()
    writeFileSync(`${file}.lock`, '999999', 'utf-8') // 无人释放的陈锁
    const t0 = Date.now()
    writeLocalState({ device: 'me', status: 'idle' })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(400) // 经历过自旋等待（≤500ms 接管）
    expect(elapsed).toBeLessThan(3000) // 不永久阻塞
    expect(readState().device).toBe('me')
    expect(existsSync(`${file}.lock`)).toBe(false) // 接管后释放
  })

  it('writeActive 同规格互斥：陈锁超时接管后写入成功', () => {
    const file = activeFilePath()
    writeFileSync(`${file}.lock`, 'stale', 'utf-8')
    const t0 = Date.now()
    writeActive({ device: 'me', lastActiveAt: Date.now(), lastInput: '并发输入' })
    expect(Date.now() - t0).toBeLessThan(3000)
    const st = readActive()!
    expect(st.lastInput).toBe('并发输入')
    expect(existsSync(`${file}.lock`)).toBe(false)
  })
})
