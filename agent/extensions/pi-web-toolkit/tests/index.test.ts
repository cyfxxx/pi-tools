import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

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

// Mock config so proxy_pool is not set (no network/binary dependencies)
vi.mock('../config', () => ({
  loadConfig: () => ({
    search: { searxng_url: 'https://searx.be', timeout: 5000 },
    browser: { headless: false, viewport_width: 1280, viewport_height: 800 },
  }),
}))

// Mock cloakbrowser
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
      evaluate: vi.fn().mockResolvedValue({ text: '', headings: [], paragraphs: [] }),
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

describe('index (entry point)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredTools.length = 0
    Object.keys(lifecycleHandlers).forEach(k => delete lifecycleHandlers[k])
  })

  it('should register core tools and lifecycle hooks', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const toolNames = registeredTools.map(t => t.name)
    expect(toolNames).toContain('web_search')
    expect(toolNames).toContain('browser_navigate')
    expect(toolNames).toContain('browser_screenshot')
    expect(toolNames).toContain('browser_click')
    expect(toolNames).toContain('browser_type')
    expect(toolNames).toContain('browser_scroll')
    expect(toolNames).toContain('browser_extract')
    expect(toolNames).toContain('browser_evaluate')
    expect(toolNames).toContain('browser_close')
    expect(registeredTools.length).toBeGreaterThanOrEqual(9)

    expect(lifecycleHandlers['session_shutdown']).toBeDefined()
    expect(lifecycleHandlers['session_compact']).toBeDefined()
  })

  it('should NOT register proxy tools when no proxy_pool config', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const toolNames = registeredTools.map(t => t.name)
    expect(toolNames).not.toContain('proxy_status')
    expect(toolNames).not.toContain('proxy_add')
    expect(toolNames).not.toContain('proxy_rotate')
    expect(toolNames).not.toContain('proxy_on')
    expect(toolNames).not.toContain('proxy_off')
    expect(toolNames).not.toContain('proxy_set')
  })

  it('browser_navigate should return page info', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const navTool = registeredTools.find(t => t.name === 'browser_navigate')!
    const result = await navTool.execute('id', {
      url: 'https://example.com',
    }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('页面标题')
  })

  it('should handle screenshot tool', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const navTool = registeredTools.find(t => t.name === 'browser_navigate')!
    await navTool.execute('id', { url: 'https://example.com' }, undefined, undefined, {} as any)

    const ssTool = registeredTools.find(t => t.name === 'browser_screenshot')!
    const result = await ssTool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('截图已保存')
  })

  it('should clean screenshots on session_shutdown', async () => {
    const fs = await import('fs/promises')
    const testFile = '/tmp/pi-screenshot-test-clean.png'
    await fs.writeFile(testFile, 'test')

    const main = (await import('../index')).default
    await main(mockPi as any)

    await lifecycleHandlers['session_shutdown']()

    const exists = await fs.access(testFile).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('should trim screenshots on session_compact', async () => {
    const fs = await import('fs/promises')
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(`/tmp/pi-screenshot-test-compact-${i}.png`, 'test')
    }

    const main = (await import('../index')).default
    await main(mockPi as any)

    await lifecycleHandlers['session_compact']()

    const files = (await fs.readdir('/tmp'))
      .filter(f => f.startsWith('pi-screenshot-test-compact-'))
    expect(files.length).toBeLessThanOrEqual(20)

    await Promise.all(files.map(f => fs.unlink(join('/tmp', f))))
  })
})
