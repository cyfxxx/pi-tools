import { describe, it, expect, vi, beforeEach } from 'vitest'

const registeredTools: Array<{ name: string; execute: Function }> = []
const lifecycleHandlers: Record<string, Function> = {}

const mockPi = {
  registerTool: vi.fn((tool: { name: string; execute: Function }) => {
    registeredTools.push({ name: tool.name, execute: tool.execute })
  }),
  on: vi.fn((event: string, handler: Function) => {
    lifecycleHandlers[event] = handler
  }),
}

// Mock config WITH proxy_pool enabled
vi.mock('../config', () => ({
  loadConfig: () => ({
    search: { searxng_url: 'https://searx.be', timeout: 5000 },
    browser: { headless: false, viewport_width: 1280, viewport_height: 800 },
    proxy_pool: {
      enabled: true,
      sing_box: {
        binary_path: '/nonexistent/sing-box',
        work_dir: '/tmp/sing-box-test',
        mixed_port: 19998,
        external_controller_port: 9090,
        log_level: 'error',
      },
      subscription_urls: [],
      strategy: 'round-robin' as const,
      health_check_url: 'http://httpbin.org/ip',
      health_check_interval: 300,
      fallback_direct: true,
    },
  }),
}))

vi.mock('cloakbrowser', () => ({
  launch: vi.fn().mockResolvedValue({
    isConnected: vi.fn().mockReturnValue(true),
    newPage: vi.fn().mockResolvedValue({
      isClosed: vi.fn().mockReturnValue(false),
      goto: vi.fn().mockResolvedValue(undefined),
      setViewportSize: vi.fn(),
      url: vi.fn().mockReturnValue('about:blank'),
      title: vi.fn().mockResolvedValue(''),
      content: vi.fn().mockResolvedValue('<html></html>'),
      evaluate: vi.fn().mockResolvedValue(''),
      screenshot: vi.fn().mockResolvedValue('/tmp/test-screenshot.png'),
      close: vi.fn(),
      mouse: { click: vi.fn() },
      fill: vi.fn(),
      keyboard: { type: vi.fn() },
      $: vi.fn(),
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 800 }),
    }),
    close: vi.fn(),
  }),
}))

// Mock proxy-pool module: return a constructor that produces a mock instance
const mockProxyPool = {
  init: vi.fn().mockResolvedValue(undefined),
  isRunning: vi.fn().mockReturnValue(false),
  getLocalProxyUrl: vi.fn().mockReturnValue('http://127.0.0.1:19998'),
  getStats: vi.fn().mockResolvedValue({
    total: 5,
    alive: 3,
    dead: 2,
    avgLatency: 120,
    strategy: 'round-robin',
    current: 'proxy-01',
    systemProxyEnabled: false,
    systemProxyUrl: null,
    entries: [
      { url: 'proxy-01', alive: true, latency: 100, failures: 0, isCurrent: true },
      { url: 'proxy-02', alive: true, latency: 150, failures: 0, isCurrent: false },
      { url: 'proxy-03', alive: true, latency: 110, failures: 0, isCurrent: false },
      { url: 'proxy-04', alive: false, latency: 0, failures: 3, isCurrent: false },
      { url: 'proxy-05', alive: false, latency: 0, failures: 5, isCurrent: false },
    ],
  }),
  rotate: vi.fn().mockResolvedValue('proxy-02'),
  addProxies: vi.fn().mockResolvedValue(undefined),
  enableSystemProxy: vi.fn(),
  disableSystemProxy: vi.fn(),
  stop: vi.fn(),
}

vi.mock('../proxy/pool', () => {
  return {
    ProxyPool: vi.fn().mockImplementation(function () {
      return mockProxyPool
    }),
  }
})

describe('proxy control tools (with config)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredTools.length = 0
    Object.keys(lifecycleHandlers).forEach(k => delete lifecycleHandlers[k])
  })

  it('should register all 6 proxy control tools', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const toolNames = registeredTools.map(t => t.name)
    expect(toolNames).toContain('proxy_status')
    expect(toolNames).toContain('proxy_add')
    expect(toolNames).toContain('proxy_rotate')
    expect(toolNames).toContain('proxy_on')
    expect(toolNames).toContain('proxy_off')
    expect(toolNames).toContain('proxy_set')
  })

  it('proxy_status should return pool stats', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'proxy_status')!
    const result = await tool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('代理池状态')
    expect(result.content[0].text).toContain('系统代理')
  })

  it('proxy_on should enable system proxy', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'proxy_on')!
    const result = await tool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('系统代理已启用')
  })

  it('proxy_off should disable system proxy', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'proxy_off')!
    const result = await tool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('系统代理已禁用')
  })

  it('proxy_set should add proxy and enable system proxy', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'proxy_set')!
    const result = await tool.execute('id', { proxy: 'http://1.2.3.4:8080' }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('已添加代理')
    expect(result.content[0].text).toContain('并启用系统代理')
  })

  it('proxy_rotate should switch to next proxy', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'proxy_rotate')!
    const result = await tool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('已轮转至代理')
  })
})
