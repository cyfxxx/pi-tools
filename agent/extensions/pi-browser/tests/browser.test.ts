import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'os'

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
  const { BrowserManager } = await import('../browser/impl')
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

  it('should close browser launched during close() (launch 竞态不泄漏进程)', async () => {
    const bm = await getBrowserManager()
    // 挂起 launch：确保 close() 被调用时 initializing 仍在进行中
    let resolveLaunch!: (b: unknown) => void
    const cloakModule = await import('cloakbrowser')
    ;(cloakModule.launch as any).mockImplementation(
      () => new Promise((res) => { resolveLaunch = res }),
    )
    const launching = bm.ensureBrowser()
    // 等 launch 真正开始执行（executor 运行后 resolveLaunch 才被赋值）
    await vi.waitFor(() => {
      expect(resolveLaunch).toBeTypeOf('function')
    })
    const closing = bm.close()
    // launch 尚未完成：此时不能关闭（browser 尚未赋值）
    expect(mockBrowser.close).not.toHaveBeenCalled()
    // 让 launch 完成——close() 应等待它并关闭刚赋值给 this.browser 的实例
    resolveLaunch(mockBrowser)
    await closing
    await launching
    expect(mockBrowser.close).toHaveBeenCalledTimes(1)
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
    // 截图目录 = tmpdir()/pi-browser-screenshots（兼容 Termux 无 /tmp）
    expect(path).toMatch(new RegExp(`${tmpdir().replace(/[.\\+*?[^\\]$(){}=!<>|:-]/g, '\\$&')}/pi-browser-screenshots/pi-screenshot-\\d+\\.png`))
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
