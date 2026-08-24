import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
