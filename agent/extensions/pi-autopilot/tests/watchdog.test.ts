import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = await mkdtemp(join(tmpdir(), 'pi-autopilot-watchdog-'))

const { __setAgentDir } = await import('./__mocks__/pi-coding-agent')
__setAgentDir(TEST_DIR)

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

const { touchActivity, isHanging, triggerHangRecovery } = await import('../watchdog')

describe('watchdog', () => {
  beforeEach(async () => {
    await rm(join(TEST_DIR, '.pi-admin-state.json'), { force: true })
  })

  it('isHanging false right after activity', async () => {
    touchActivity()
    expect(await isHanging(10)).toBe(false)
  })

  it('isHanging true when idle exceeds threshold (injected now)', async () => {
    touchActivity()
    expect(await isHanging(5, Date.now() + 10 * 60 * 1000)).toBe(true)
  })

  it('no hanging when threshold disabled', async () => {
    touchActivity()
    expect(await isHanging(0, Date.now() + 1000000)).toBe(false)
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
