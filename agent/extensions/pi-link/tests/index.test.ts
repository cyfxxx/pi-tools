import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'

// 状态写入并发锁用例不涉及 spawn；并发探测用例需要 mock ssh。整文件统一 mock。
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock, exec: vi.fn(), execSync: vi.fn() }))

const mockPi = () => ({
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  registerFlag: vi.fn(),
  registerShortcut: vi.fn(),
  on: vi.fn(),
  sendMessage: vi.fn(),
  appendEntry: vi.fn(),
  sendUserMessage: vi.fn(),
  setActiveTools: vi.fn(),
  getFlag: vi.fn(() => false),
})

describe('pi-link extension', () => {
  it('registers link_send and link_status tools', async () => {
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const tools = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].name)
    expect(tools).toContain('link_send')
    expect(tools).toContain('link_status')
    const desc = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].description).join('\n')
    expect(desc).toContain('/link help')
  })

  it('registers single /link command with help', async () => {
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const cmds = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(cmds).toEqual(['link'])
    const def = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(def.description).toContain('link')
    // handler 通过 sendMessage 输出帮助全文
    const ctx = { ui: { notify: vi.fn() } }
    await def.handler('help', ctx)
    const sent = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent.content).toContain('link_send')
    expect(sent.content).toContain('pi-link.json')
  })

  it('link_send 无设备/无消息时报参数错误', async () => {
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const tools = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls
    const send = tools.find((c) => c[0].name === 'link_send')![0]
    expect((await send.execute('id', {})).isError).toBe(true)
    expect((await send.execute('id', { device: 'x' })).isError).toBe(true)
  })

  it('link_send 未知设备报错并列出已配置', async () => {
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const send = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0].name === 'link_send')![0]
    const r = await send.execute('id', { device: 'nope', message: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('未知设备')
  })
})

// ── 审计修复回归（2026-08-26）─────────────────────────────
describe('pi-link: import-card 参数解析（off-by-one 审计修复）', () => {
  let dir: string
  let cfgFile: string
  const prevEnv = process.env.PI_LINK_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-link-import-'))
    cfgFile = join(dir, 'pi-link.json')
    process.env.PI_LINK_CONFIG = cfgFile
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_LINK_CONFIG
    else process.env.PI_LINK_CONFIG = prevEnv
    rmSync(dir, { recursive: true, force: true })
  })

  const mockPi = () => ({
    registerTool: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(),
    registerShortcut: vi.fn(), on: vi.fn(), sendMessage: vi.fn(),
    appendEntry: vi.fn(), sendUserMessage: vi.fn(), setActiveTools: vi.fn(),
    getFlag: vi.fn(() => false),
  })

  async function runHandler(args: string): Promise<{ pi: ReturnType<typeof mockPi>; sent: string[] }> {
    const pi = mockPi()
    const main = (await import('../index')).default
    main(pi as never)
    const handler = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1].handler
    await handler(args, { ui: { notify: vi.fn() } })
    return { pi, sent: (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0].content)) }
  }

  it('单 token JSON 卡片完整入参（修复前 slice(2) 吞掉首 token 必败）', async () => {
    const card = JSON.stringify({ name: 'card-dev', skills: ['pi'], host: '10.1.1.1', user: 'u1', port: 8022 })
    const { sent } = await runHandler(`import-card ${card}`)
    expect(sent.join('\n')).toContain('已添加设备')
    const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
    expect(saved.devices['card-dev']).toMatchObject({ host: '10.1.1.1', user: 'u1', port: 8022 })
  })

  it('JSON 内含多空格不破损（从原始串按首个空格切分，不 split/重 join）', async () => {
    // JSON token 之间塞多空格：修复前 split(/\s+/)+join(' ') 压缩成单空格且吞首 token；
    // 修复后原始余串直通 JSON.parse
    const raw = '{  "name": "sp-dev",  "skills": ["a  b"],  "host": "10.1.1.2",  "user": "u2",  "port": 22 }'
    const { sent } = await runHandler(`import-card ${raw}`)
    expect(sent.join('\n')).toContain('已添加设备')
    const saved = JSON.parse(readFileSync(cfgFile, 'utf-8'))
    expect(saved.devices['sp-dev'].user).toBe('u2')
  })

  it('空参数提示用法，不写配置', async () => {
    const { pi } = await runHandler('import-card')
    expect((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
    expect(existsSync(cfgFile)).toBe(false)
  })
})

describe('pi-link: /link status 并发探测（保序，审计修复）', () => {
  let dir: string
  let cfgFile: string
  const prevEnv = { config: process.env.PI_LINK_CONFIG, state: process.env.PI_LINK_STATE_DIR }
  let inFlight = 0
  let maxInFlight = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-link-status-'))
    cfgFile = join(dir, 'pi-link.json')
    process.env.PI_LINK_CONFIG = cfgFile
    process.env.PI_LINK_STATE_DIR = dir
    inFlight = 0
    maxInFlight = 0
    spawnMock.mockReset()
    // probeAddr 形态的 ssh：echo pi-link-ok 后 exit 0；slow 设备延迟更长。
    // 统计最大并发：修复前串行探测 maxInFlight===1，修复后 ===2
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const target = args.find((a) => a.includes('@')) ?? ''
      const delay = target.includes('slow@') ? 120 : 20
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const exitCbs: Array<(c: number) => void> = []
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        stdout.emit('data', 'pi-link-ok\n')
        inFlight--
        for (const cb of exitCbs) cb(0)
      }, delay)
      return {
        stdin: new PassThrough(), stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
      }
    })
  })
  afterEach(() => {
    if (prevEnv.config === undefined) delete process.env.PI_LINK_CONFIG
    else process.env.PI_LINK_CONFIG = prevEnv.config
    if (prevEnv.state === undefined) delete process.env.PI_LINK_STATE_DIR
    else process.env.PI_LINK_STATE_DIR = prevEnv.state
    rmSync(dir, { recursive: true, force: true })
  })

  it('两台设备并发探测（最大同时在飞 2）且输出按配置顺序保序', async () => {
    writeFileSync(cfgFile, JSON.stringify({
      devices: {
        slow: { host: '10.9.0.1', user: 'slow', port: 22 },
        fast: { host: '10.9.0.2', user: 'fast', port: 22 },
      },
    }))
    const pi = {
      registerTool: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(),
      registerShortcut: vi.fn(), on: vi.fn(), sendMessage: vi.fn(),
      appendEntry: vi.fn(), sendUserMessage: vi.fn(), setActiveTools: vi.fn(),
      getFlag: vi.fn(() => false),
    }
    const main = (await import('../index')).default
    main(pi as never)
    const handler = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1].handler
    await handler('status', { ui: { notify: vi.fn() } })
    const out = String((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content)
    // 保序：slow（配置在前）先展示，即使它更慢才返回
    expect(out.indexOf('slow@10.9.0.1')).toBeGreaterThan(-1)
    expect(out.indexOf('fast@10.9.0.2')).toBeGreaterThan(out.indexOf('slow@10.9.0.1'))
    expect(out).toContain('可达')
    // 并发：修复前串行 probeDevice 两次 spawn 互不重叠（maxInFlight=1）
    expect(maxInFlight).toBe(2)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('单台不可达：其余设备不受影响，保序展示不可达明细', async () => {
    writeFileSync(cfgFile, JSON.stringify({
      devices: {
        dead: { host: '10.9.0.9', user: 'dead', port: 22 },
        alive: { host: '10.9.0.2', user: 'fast', port: 22 },
      },
    }))
    // dead 探测 exit 255
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const target = args.find((a) => a.includes('@')) ?? ''
      const ok = !target.includes('dead@')
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const exitCbs: Array<(c: number) => void> = []
      setTimeout(() => {
        if (ok) stdout.emit('data', 'pi-link-ok\n')
        else stderr.emit('data', 'connection refused\n')
        for (const cb of exitCbs) cb(ok ? 0 : 255)
      }, 10)
      return {
        stdin: new PassThrough(), stdout, stderr,
        kill: vi.fn(),
        on: (ev: string, cb: (c: number) => void) => { if (ev === 'exit') exitCbs.push(cb) },
      }
    })
    const pi = {
      registerTool: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(),
      registerShortcut: vi.fn(), on: vi.fn(), sendMessage: vi.fn(),
      appendEntry: vi.fn(), sendUserMessage: vi.fn(), setActiveTools: vi.fn(),
      getFlag: vi.fn(() => false),
    }
    const main = (await import('../index')).default
    main(pi as never)
    const handler = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1].handler
    await handler('status', { ui: { notify: vi.fn() } })
    const out = String((pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content)
    expect(out).toContain('不可达')
    expect(out.indexOf('dead@10.9.0.9')).toBeGreaterThan(-1)
    expect(out.indexOf('fast@10.9.0.2')).toBeGreaterThan(out.indexOf('dead@10.9.0.9'))
  })
})
