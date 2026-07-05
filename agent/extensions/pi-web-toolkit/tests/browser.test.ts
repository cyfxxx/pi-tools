import { describe, it, expect, vi, beforeEach } from 'vitest'

function createMockPage() {
  return {
    isClosed: vi.fn().mockReturnValue(false),
    goto: vi.fn().mockResolvedValue(undefined),
    setViewportSize: vi.fn(),
    url: vi.fn().mockReturnValue('about:blank'),
    title: vi.fn().mockResolvedValue(''),
    content: vi.fn().mockResolvedValue('<html></html>'),
    evaluate: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue('/tmp/screenshot.png'),
    close: vi.fn(),
    mouse: { click: vi.fn() },
    fill: vi.fn(),
    keyboard: { type: vi.fn() },
    $: vi.fn(),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 800 }),
  }
}

function createMockBrowser() {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    newPage: vi.fn(),
    close: vi.fn(),
  }
}

let mockPage: ReturnType<typeof createMockPage>
let mockBrowser: ReturnType<typeof createMockBrowser>

vi.mock('cloakbrowser', () => ({
  launch: vi.fn(),
}))

async function getBrowserManager() {
  const { BrowserManager } = await import('../src/browser')
  const config = { headless: false, viewport_width: 1280, viewport_height: 800 }
  const bm = new BrowserManager(config)
  return bm
}

describe('BrowserManager', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    mockPage = createMockPage()
    mockBrowser = createMockBrowser()
    mockBrowser.newPage.mockResolvedValue(mockPage)

    const cloakModule = await import('cloakbrowser')
    ;(cloakModule.launch as any).mockResolvedValue(mockBrowser)
  })

  it('should construct with default config', async () => {
    const bm = await getBrowserManager()
    expect(bm).toBeDefined()
    expect(bm.isPageActive()).toBe(false)
  })

  it('should launch browser on ensureBrowser()', async () => {
    const bm = await getBrowserManager()
    const browser = await bm.ensureBrowser()
    expect(browser).toBeDefined()
  })

  it('should return false for isPageActive when no page', async () => {
    const bm = await getBrowserManager()
    expect(bm.isPageActive()).toBe(false)
  })

  it('should navigate and return PageInfo', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    mockPage.evaluate.mockResolvedValue('Hello World')

    const info = await bm.navigate('https://example.com')
    expect(info.url).toBe('https://example.com')
    expect(info.title).toBe('Example')
    expect(info.textContent).toBe('Hello World')
  })

  it('should be active after navigation', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    await bm.navigate('https://example.com')
    expect(bm.isPageActive()).toBe(true)
  })

  it('should close browser and page', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    await bm.navigate('https://example.com')
    await bm.close()
    expect(mockPage.close).toHaveBeenCalled()
    expect(mockBrowser.close).toHaveBeenCalled()
    expect(bm.isPageActive()).toBe(false)
  })

  it('should navigate fallback from networkidle to load', async () => {
    const bm = await getBrowserManager()
    mockPage.goto
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined)
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')

    const info = await bm.navigate('https://example.com')
    expect(info.url).toBe('https://example.com')
    expect(mockPage.goto).toHaveBeenCalledTimes(2)
  })

  it('should aggregate errors from both navigation attempts (M12)', async () => {
    const bm = await getBrowserManager()
    mockPage.goto
      .mockRejectedValueOnce(new Error('networkidle timeout'))
      .mockRejectedValueOnce(new Error('load timeout'))

    await expect(bm.navigate('https://example.com')).rejects.toThrow(
      '导航失败: networkidle timeout; load timeout'
    )
  })

  it('should abort navigation when signal is aborted', async () => {
    const bm = await getBrowserManager()
    const ac = new AbortController()
    ac.abort()
    mockPage.goto.mockRejectedValue(new Error('aborted'))
    await expect(bm.navigate('https://example.com', ac.signal)).rejects.toThrow('导航已取消')
  })

  it('should take screenshot and return path', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    mockPage.evaluate.mockResolvedValue('')
    await bm.navigate('https://example.com')

    const path = await bm.screenshot()
    expect(path).toMatch(/\/tmp\/pi-screenshot-\d+\.png/)
  })

  it('should support click with coordinates and button type', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    mockPage.evaluate.mockResolvedValue('')
    await bm.navigate('https://example.com')

    await bm.click(100, 200, 'right')
    expect(mockPage.mouse.click).toHaveBeenCalledWith(100, 200, { button: 'right' })
  })
})
