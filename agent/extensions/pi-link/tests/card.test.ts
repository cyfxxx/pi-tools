import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = join(tmpdir(), `pi-link-card-test-${Date.now()}`)
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TMP }
})
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  execSync: vi.fn(() => '100.64.99.99\n'),
}))

import { buildCard, validateCard, cardToDevice, detectTailscaleIP } from '../card.ts'
import { saveDevice, loadConfig, configPath } from '../config.ts'

describe('pi-link: 设备卡片（T2-5）', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
  })
  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch { /* */ }
  })

  it('buildCard: 生成含 Tailscale IP 的卡片', () => {
    const card = buildCard({ devices: {}, defaultTimeoutSec: 600, selfName: 'mydev' })
    expect(card.name).toBe('mydev')
    expect(card.host).toBe('100.64.99.99')
    expect(card.pi).toBe(true)
    expect(card.skills.length).toBeGreaterThan(0)
  })

  it('detectTailscaleIP: 返回第一个 IPv4', () => {
    expect(detectTailscaleIP()).toBe('100.64.99.99')
  })

  it('validateCard: 合法卡片通过', () => {
    const v = validateCard({ name: 'desk', host: '10.0.0.8', user: 'me', port: 2222, skills: ['a', 'b'] })
    expect(v.ok).toBe(true)
    expect(v.card?.name).toBe('desk')
    expect(v.card?.port).toBe(2222)
    expect(v.card?.skills).toEqual(['a', 'b'])
  })

  it('validateCard: 缺字段/非法端口拒绝', () => {
    expect(validateCard({ host: 'x', user: 'u' }).ok).toBe(false)
    expect(validateCard({ name: 'n', host: 'x', user: 'u', port: 70000 }).ok).toBe(false)
    // 字符串端口宽容处理（跨设备格式差异）
    expect(validateCard({ name: 'n', host: 'x', user: 'u', port: '22' }).ok).toBe(true)
    expect(validateCard(null).ok).toBe(false)
  })

  it('cardToDevice: 卡片转设备配置', () => {
    const d = cardToDevice({ name: 'n', skills: [], host: 'h', user: 'u', port: 8022, pi: true })
    expect(d).toEqual({ host: 'h', user: 'u', port: 8022 })
  })

  it('saveDevice: 写入 pi-link.json 并可从配置读回', () => {
    const p = configPath()
    const r = saveDevice(p, 'newdev', { host: '10.1.1.1', user: 'u', port: 22 })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('已添加')
    const cfg = loadConfig(p)
    expect(cfg.devices['newdev']).toEqual({ host: '10.1.1.1', user: 'u', port: 22 })

    // 更新已存在设备
    const r2 = saveDevice(p, 'newdev', { host: '10.1.1.2', user: 'u' })
    expect(r2.detail).toContain('已更新')
    expect(loadConfig(p).devices['newdev'].host).toBe('10.1.1.2')
  })

  it('saveDevice: 非法设备名拒绝', () => {
    expect(saveDevice(configPath(), 'bad name!', { host: 'h', user: 'u' }).ok).toBe(false)
  })

  it('saveDevice: 保留既有设备（不覆盖其他项）', () => {
    const p = configPath()
    mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true })
    writeFileSync(p, JSON.stringify({ devices: { old: { host: 'a', user: 'b' } }, defaultTimeoutSec: 300, selfName: 'x' }))
    saveDevice(p, 'new', { host: 'c', user: 'd' })
    const cfg = loadConfig(p)
    expect(cfg.devices['old'].host).toBe('a')
    expect(cfg.devices['new'].host).toBe('c')
    expect(cfg.defaultTimeoutSec).toBe(300)
    expect(cfg.selfName).toBe('x')
  })
})
