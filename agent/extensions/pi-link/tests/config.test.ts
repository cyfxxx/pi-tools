import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-link-cfg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 审计 MEDIUM（2026-08-24）：loadConfig 仅校验 host 时，手工编辑 pi-link.json
// 可绕过 import-card 的加固——user 以 `-` 开头/含空白会被 ssh 解析为选项注入
// （如 -o ProxyCommand → 本机执行面）。加载时同规则校验，非法字段丢弃回退默认。
describe('pi-link config 加载校验（审计 MEDIUM 修复）', () => {
  it('非法 user（- 开头 / 含空白）被丢弃，合法 user 保留', async () => {
    const { loadConfig } = await import('../config.ts')
    const p = join(dir, 'pi-link.json')
    writeFileSync(
      p,
      JSON.stringify({
        devices: {
          good: { host: '10.0.0.1', user: 'root' },
          optInj: { host: '10.0.0.2', user: '-oProxyCommand=echo pwned@' },
          blank: { host: '10.0.0.3', user: 'my user' },
        },
      }),
    )
    const cfg = loadConfig(p)
    expect(cfg.devices.good.user).toBe('root')
    // 注入/非法 user 被丢弃 → 设备回退默认
    expect(cfg.devices.optInj.user).toBeUndefined()
    expect(cfg.devices.blank.user).toBeUndefined()
  })

  it('非法 port / sshArgs 形态被丢弃，合法保留', async () => {
    const { loadConfig } = await import('../config.ts')
    const p = join(dir, 'pi-link.json')
    writeFileSync(
      p,
      JSON.stringify({
        devices: {
          bad: { host: 'h1', port: 99999, sshArgs: 'nope' },
          ok: { host: 'h2', port: 22, sshArgs: ['-i', '/root/.ssh/id'] },
        },
      }),
    )
    const cfg = loadConfig(p)
    expect(cfg.devices.bad.port).toBeUndefined()
    expect(cfg.devices.bad.sshArgs).toBeUndefined()
    expect(cfg.devices.ok.port).toBe(22)
    expect(cfg.devices.ok.sshArgs).toEqual(['-i', '/root/.ssh/id'])
  })
})

// 审计 MEDIUM：host/altHosts 此前仅判非空——手工编辑 pi-link.json 可绕过
// import-card 的 isValidUserHost 加固（- 开头/含空白 host 被 ssh 解析为选项）。
// 加载时严格校验：host 不合格整台设备跳过并告警；altHosts 逐项校验，不合格条目丢弃。
describe('pi-link config host 严格校验（isValidUserHost 套用）', () => {
  it('恶意 host（- 开头选项注入 / 含空白 / 超长）→ 整台设备跳过并告警', async () => {
    const { loadConfig } = await import('../config.ts')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = join(dir, 'pi-link.json')
      writeFileSync(
        p,
        JSON.stringify({
          devices: {
            optInj: { host: '-oProxyCommand=echo pwned@', user: 'root' },
            spaced: { host: '10.0.0.1 -oProxyCommand=x', user: 'root' },
            oversize: { host: 'h'.repeat(254), user: 'root' },
            good: { host: '100.101.102.103', user: 'u0_a123' },
          },
        }),
      )
      const cfg = loadConfig(p)
      expect(cfg.devices.optInj).toBeUndefined()
      expect(cfg.devices.spaced).toBeUndefined()
      expect(cfg.devices.oversize).toBeUndefined()
      expect(cfg.devices.good.user).toBe('u0_a123')
      expect(warnSpy).toHaveBeenCalledTimes(3)
      expect((warnSpy.mock.calls[0]?.[0] as string)).toContain('optInj')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('altHosts 逐项严格校验：非法条目丢弃并告警，合法条目与设备本身保留', async () => {
    const { loadConfig } = await import('../config.ts')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const p = join(dir, 'pi-link.json')
      writeFileSync(
        p,
        JSON.stringify({
          devices: {
            mixed: {
              host: '10.0.0.1',
              user: 'u',
              altHosts: [{ host: '10.0.0.2' }, { host: '-oProxyCommand=evil' }, { host: 'bad host' }, {}],
            },
          },
        }),
      )
      const cfg = loadConfig(p)
      expect(cfg.devices.mixed).toBeDefined()
      expect(cfg.devices.mixed.altHosts).toEqual([{ host: '10.0.0.2' }])
      expect(warnSpy).toHaveBeenCalledTimes(3)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
