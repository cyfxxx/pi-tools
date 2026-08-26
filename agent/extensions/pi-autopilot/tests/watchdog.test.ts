import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-watchdog-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)
// 双层隔离：即使 vitest 别名失效（agent 根直跑），状态写入也重定向到临时目录
process.env.PI_ADMIN_STATE_FILE = join(TEST_DIR, '.pi-admin-state.json')

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { touchActivity, isHanging, triggerHangRecovery } = await import('../watchdog')

// 需要 setTurnBusy 重置用例间模块状态（busyTurn/busySince 是模块级变量）
let setTurnBusy: (b: boolean) => void

describe('watchdog', () => {
  beforeEach(async () => {
    await rm(join(TEST_DIR, '.pi-admin-state.json'), { force: true })
    if (!setTurnBusy) setTurnBusy = (await import('../watchdog')).setTurnBusy
    setTurnBusy(false)
  })

  it('isHanging false right after activity', async () => {
    touchActivity()
    expect(await isHanging(10)).toBe(false)
  })

  it('isHanging false during busy turn within grace (长工具执行豁免)', async () => {
    const { setTurnBusy } = await import('../watchdog')
    touchActivity()
    setTurnBusy(true)
    // 模拟 8 分钟无活动（工具静默执行），在豁免上限（2×5min=10min）内不应误判挂死
    expect(await isHanging(5, Date.now() + 8 * 60 * 1000)).toBe(false)
    setTurnBusy(false)
    expect(await isHanging(5, Date.now() + 8 * 60 * 1000)).toBe(true)
  })

  it('isHanging true when busy exceeds grace (turn 内真挂死，审计 MEDIUM 修复)', async () => {
    const { setTurnBusy } = await import('../watchdog')
    touchActivity()
    setTurnBusy(true)
    // busy 40 分钟（> 2×5min 豁免上限）：turn_end 永不发出的真挂死不再被永久豁免
    expect(await isHanging(5, Date.now() + 40 * 60 * 1000)).toBe(true)
  })

  it('isHanging true when idle exceeds threshold (injected now)', async () => {
    touchActivity()
    expect(await isHanging(5, Date.now() + 10 * 60 * 1000)).toBe(true)
  })

  it('no hanging when threshold disabled', async () => {
    touchActivity()
    expect(await isHanging(0, Date.now() + 1000000)).toBe(false)
  })

  it('not hanging right after startup even if old session files exist', async () => {
    // 复现 bug：启动初期 lastActivity 新鲜，但会话文件还是旧文件的 mtime
    const oldDir = join(TEST_DIR, 'sessions', '--stale-cwd--')
    await mkdir(oldDir, { recursive: true })
    const oldFile = join(oldDir, 'old.jsonl')
    await writeFile(oldFile, '')
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, longAgo, longAgo)
    touchActivity()
    expect(await isHanging(5, Date.now() + 60 * 1000)).toBe(false)
  })

  it('hanging only when both activity idle AND session file stale', async () => {
    const oldDir = join(TEST_DIR, 'sessions', '--stale-cwd-2--')
    await mkdir(oldDir, { recursive: true })
    const oldFile = join(oldDir, 'old.jsonl')
    await writeFile(oldFile, '')
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    await utimes(oldFile, longAgo, longAgo)
    touchActivity()
    // lastActivity 超时 + 会话文件同样陈旧 → 挂死
    expect(await isHanging(5, Date.now() + 10 * 60 * 1000)).toBe(true)
  })

  it('triggerHangRecovery writes restart state and returns true', async () => {
    touchActivity()
    const ok = await triggerHangRecovery(5, Date.now() + 10 * 60 * 1000)
    expect(ok).toBe(true)
    const { readFile } = await import('fs/promises')
    const state = JSON.parse(await readFile(join(TEST_DIR, '.pi-admin-state.json'), 'utf-8'))
    expect(state.action).toBe('restart_hang')
    expect(state.reason).toContain('挂死')
  })

  it('triggerHangRecovery does nothing when healthy', async () => {
    touchActivity()
    expect(await triggerHangRecovery(60)).toBe(false)
  })
})
