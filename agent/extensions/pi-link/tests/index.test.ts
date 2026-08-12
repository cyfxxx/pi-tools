import { describe, it, expect, vi } from 'vitest'

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
