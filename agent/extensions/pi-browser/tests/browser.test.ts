import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join, relative, resolve, isAbsolute, basename, sep } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'

function createMockPage() {
  return {
    isClosed: vi.fn().mockReturnValue(false),
    on: vi.fn(),
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

/** 各 describe 共用：重置共享 mock 并让 launch 返回当前 mockBrowser。 */
async function setupMocks() {
  vi.restoreAllMocks()
  mockPage = createMockPage()
  mockBrowser = createMockBrowser()
  mockBrowser.newPage.mockResolvedValue(mockPage)
  const cloakModule = await import('cloakbrowser')
  ;(cloakModule.launch as any).mockResolvedValue(mockBrowser)
}

async function getBrowserManager() {
  const { BrowserManager } = await import('../browser/impl')
  const config = { headless: false, viewport_width: 1280, viewport_height: 800 }
  const bm = new BrowserManager(config)
  return bm
}

// 审计 LOW：截图目录按进程专属（含 pid），多进程不共享同名目录
function currentShotDir(): string {
  return join(tmpdir(), `pi-browser-screenshots-${process.pid}`)
}

describe('BrowserManager', () => {
  beforeEach(setupMocks)

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

  it('should reject dangerous protocols (审计 MEDIUM：file:// 读取本地文件防护)', async () => {
    const bm = await getBrowserManager()
    await expect(bm.navigate('file:///etc/passwd')).rejects.toThrow('协议不支持')
    await expect(bm.navigate('data:text/html,<script>alert(1)</script>')).rejects.toThrow('协议不支持')
    await expect(bm.navigate('javascript:alert(1)')).rejects.toThrow('协议不支持')
    await expect(bm.navigate('not-a-url')).rejects.toThrow('无效 URL')
    // http/https 正常放行（含内网地址——本地服务合法用途）
    mockPage.url.mockReturnValue('http://127.0.0.1:8889')
    const info = await bm.navigate('http://127.0.0.1:8889')
    expect(info.url).toBe('http://127.0.0.1:8889')
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
    // 审计 LOW：截图目录 = 进程专属 tmpdir()/pi-browser-screenshots-<pid>
    //（多进程共享同名目录会导致 cleanScreenshots 跨进程误删）
    const shotsDir = currentShotDir()
    expect(path).toContain(shotsDir)
    expect(path).toMatch(/pi-screenshot-\d+-[a-z0-9]{6}\.png$/)
  })

  it('should generate collision-free screenshot filenames across rapid calls', async () => {
    const bm = await getBrowserManager()
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('Example')
    mockPage.evaluate.mockResolvedValue('')
    await bm.navigate('https://example.com')

    // 连续两次截图：文件名必须仍唯一（Date.now() 同毫秒时靠随机后缀区分）
    const pathA = await bm.screenshot()
    const pathB = await bm.screenshot()
    expect(pathA).not.toBe(pathB)
    expect(pathA).toMatch(/pi-screenshot-\d+-[a-z0-9]{6}\.png$/)
    expect(pathB).toMatch(/pi-screenshot-\d+-[a-z0-9]{6}\.png$/)
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

// ── 修复回归：win32 下 --no-proxy-server 仅在无显式代理配置时附加 ──
describe('launchBrowser win32 直连 flag 与显式代理共存', () => {
  const savedPlatform = process.platform
  const ENV_KEY = 'CLOAKBROWSER_BINARY_PATH'
  let savedEnv: string | undefined

  beforeEach(async () => {
    await setupMocks()
    savedEnv = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform })
    if (savedEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = savedEnv
  })

  async function launchOpts(extraConfig: Record<string, unknown> = {}, getProxyUrl?: () => string | null) {
    const { BrowserManager } = await import('../browser/impl')
    const config = { headless: false, viewport_width: 1280, viewport_height: 800, ...extraConfig }
    const bm = new BrowserManager(config as any, getProxyUrl)
    await bm.ensureBrowser()
    const cloakModule = await import('cloakbrowser')
    expect(cloakModule.launch).toHaveBeenCalled()
    return (cloakModule.launch as any).mock.calls.at(-1)[0] as Record<string, unknown>
  }

  it('win32 无显式代理 → 附加 --no-proxy-server（默认直连防系统代理墙）', async () => {
    const opts = await launchOpts()
    expect(opts.args).toContain('--no-proxy-server')
    expect(opts.proxy).toBeUndefined()
  })

  it('win32 有 config.proxy → 不附加 --no-proxy-server 且透传 proxy（修复回归）', async () => {
    const opts = await launchOpts({ proxy: 'http://127.0.0.1:7890' })
    expect(opts.args ?? []).not.toContain('--no-proxy-server')
    expect(opts.proxy).toEqual({ server: 'http://127.0.0.1:7890' })
  })

  it('win32 有环境代理（getProxyUrl 返回）→ 不附加 --no-proxy-server', async () => {
    const opts = await launchOpts({}, () => 'socks5://127.0.0.1:1080')
    expect(opts.args ?? []).not.toContain('--no-proxy-server')
    expect(opts.proxy).toEqual({ server: 'socks5://127.0.0.1:1080' })
  })
})

// ── 修复回归：navigate 协议安全拒绝不被外层 catch 吞掉后重试/降级文案 ──
describe('navigate 重定向安全拒绝立即终止', () => {
  beforeEach(setupMocks)

  it('落地 URL 为 file:// → 立即抛出具体文案且不以 load 模式重试', async () => {
    const bm = await getBrowserManager()
    mockPage.goto.mockResolvedValue(undefined)
    mockPage.url.mockReturnValue('file:///etc/passwd')

    await expect(bm.navigate('https://example.com')).rejects.toThrow('重定向到不允许的协议: file://')
    expect(mockPage.goto).toHaveBeenCalledTimes(1) // 不重试
  })

  it('落地 URL 为其他非 http(s) 协议同样拒绝且保留具体信息', async () => {
    const bm = await getBrowserManager()
    mockPage.goto.mockResolvedValue(undefined)
    mockPage.url.mockReturnValue('ftp://example.com/file')

    await expect(bm.navigate('https://example.com')).rejects.toThrow('ftp://')
    expect(mockPage.goto).toHaveBeenCalledTimes(1)
  })
})

// ── 修复回归：saveDownload 并发同名词下载互相覆盖 ──
describe('saveDownload 同名词防覆盖', () => {
  let tmp: string

  beforeEach(async () => {
    await setupMocks()
    tmp = mkdtempSync(join(tmpdir(), 'pi-browser-dl-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(res => { resolve = res })
    return { promise, resolve }
  }

  function fakeDownload(name: string, url: string, gate?: ReturnType<typeof deferred<void>>) {
    return {
      suggestedFilename: () => name,
      url: () => url,
      saveAs: vi.fn(() => (gate ? gate.promise : Promise.resolve())),
    }
  }

  async function managerWithDownloadListener() {
    let downloadHandler!: (d: unknown) => void
    mockPage.on = vi.fn((event: string, handler: (d: unknown) => void) => {
      if (event === 'download') downloadHandler = handler
    }) as any
    const bm = await getBrowserManager()
    bm.downloads(tmp)
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('T')
    await bm.navigate('https://example.com')
    expect(downloadHandler).toBeTypeOf('function')
    return { bm, fire: (d: unknown) => downloadHandler(d) }
  }

  it('并发同名词下载：先到者独占原名，后者获唯一后缀不覆盖（in-flight 占位）', async () => {
    const { bm, fire } = await managerWithDownloadListener()

    const g1 = deferred<void>(), g2 = deferred<void>()
    const d1 = fakeDownload('report.pdf', 'https://a/1', g1)
    const d2 = fakeDownload('report.pdf', 'https://a/2', g2)
    fire(d1) // d1 同步占住 report.pdf 后才进入 await
    fire(d2) // d2 必须看到占位，拿唯一后缀
    g1.resolve()
    g2.resolve()

    await vi.waitFor(() => expect(bm.downloads()).toHaveLength(2))
    const files = bm.downloads()
    const paths = files.map(f => f.path)
    expect(new Set(paths).size).toBe(2) // 两份文件路径互不相同，无覆盖
    expect(files.filter(f => f.filename === 'report.pdf')).toHaveLength(1) // 仅一份用原名
    expect(files.every(f => /^report(-\d+-\d+)?\.pdf$/.test(f.filename))).toBe(true)
  })

  it('顺序同名下载仍走后缀去重（原行为保持）', async () => {
    const { bm, fire } = await managerWithDownloadListener()

    fire(fakeDownload('file.zip', 'https://a/1'))
    await vi.waitFor(() => expect(bm.downloads()).toHaveLength(1))
    fire(fakeDownload('file.zip', 'https://a/2'))
    await vi.waitFor(() => expect(bm.downloads()).toHaveLength(2))

    const files = bm.downloads()
    expect(files[0].filename).toBe('file.zip')
    expect(files[1].filename).not.toBe('file.zip')
    expect(new Set(files.map(f => f.path)).size).toBe(2)
  })
})

// ── 审计回归：saveDownload 路径穿越防护（suggestedFilename 来自远端）──
describe('saveDownload 路径穿越防护', () => {
  let tmp: string

  beforeEach(async () => {
    await setupMocks()
    tmp = mkdtempSync(join(tmpdir(), 'pi-browser-dl-trav-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function managerForTraversal() {
    let downloadHandler!: (d: unknown) => void
    mockPage.on = vi.fn((event: string, handler: (d: unknown) => void) => {
      if (event === 'download') downloadHandler = handler
    }) as any
    const bm = await getBrowserManager()
    bm.downloads(tmp)
    mockPage.url.mockReturnValue('https://example.com')
    mockPage.title.mockResolvedValue('T')
    await bm.navigate('https://example.com')
    return { bm, fire: (d: unknown) => downloadHandler(d) }
  }

  it('远端建议名含 ../ 时取 basename，落盘不越出下载目录', async () => {
    const { bm, fire } = await managerForTraversal()
    fire({ suggestedFilename: () => '../../evil.txt', url: () => 'https://a/x', saveAs: () => Promise.resolve() })
    await vi.waitFor(() => expect(bm.downloads()).toHaveLength(1))
    const f = bm.downloads()[0]
    expect(f.filename).toBe('evil.txt')
    expect(f.path).toBe(join(tmp, 'evil.txt'))
    expect(f.path!.startsWith(tmp + sep)).toBe(true)
  })

  it('Windows 风格 ..\\ 分隔与裸 .. 名同样被过滤', async () => {
    const { bm, fire } = await managerForTraversal()
    fire({ suggestedFilename: () => '..\\..\\payload.exe', url: () => 'https://a/x', saveAs: () => Promise.resolve() })
    fire({ suggestedFilename: () => '..', url: () => 'https://a/y', saveAs: () => Promise.resolve() })
    await vi.waitFor(() => expect(bm.downloads()).toHaveLength(2))
    const files = bm.downloads()
    expect(files.map(f => f.filename).sort()).toEqual(['download', 'payload.exe'].sort())
    expect(files.every(f => f.path!.startsWith(tmp + sep))).toBe(true)
  })
})

// ── 审计 MEDIUM：CLOAKBROWSER_BINARY_PATH 残留指向已删文件 → 必须清除后走探测链 ──
describe('ensureLocalBinaryEnv（残留 env 清理）', () => {
  const ENV_KEY = 'CLOAKBROWSER_BINARY_PATH'
  let savedEnv: string | undefined
  let tmp: string

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY]
    tmp = mkdtempSync(join(tmpdir(), 'pi-browser-env-test-'))
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = savedEnv
    rmSync(tmp, { recursive: true, force: true })
  })

  it('env 已设且文件存在 → 保持不变', async () => {
    const realBin = join(tmp, 'chrome.exe')
    writeFileSync(realBin, 'x')
    process.env[ENV_KEY] = realBin
    const { ensureLocalBinaryEnv } = await import('../browser/impl')
    ensureLocalBinaryEnv()
    expect(process.env[ENV_KEY]).toBe(realBin)
  })

  it('审计回归：env 为相对路径且相对 cwd 存在 → 归一为绝对路径后使用', async () => {
    // 旧行为：existsSync(相对路径) 依赖 cwd，且 env 保留相对值——后续 launch
    // 读 env 时若 cwd 已变则找不到二进制。修复后必须归一为绝对路径回写。
    const tmpInCwd = mkdtempSync(join(process.cwd(), '.tmp-rel-bin-'))
    try {
      const absFile = join(tmpInCwd, 'chrome.exe')
      writeFileSync(absFile, 'x')
      process.env[ENV_KEY] = relative(process.cwd(), absFile)
      const { ensureLocalBinaryEnv } = await import('../browser/impl')
      ensureLocalBinaryEnv()
      expect(isAbsolute(process.env[ENV_KEY]!)).toBe(true)
      expect(resolve(process.env[ENV_KEY]!)).toBe(absFile)
    } finally {
      rmSync(tmpInCwd, { recursive: true, force: true })
    }
  })

  it('env 残留指向已删除文件 → 清除变量（非 win32 不复探，win32 继续探测链）', async () => {
    // 审计 MEDIUM 回归：原先非 win32 提前 return 既不复探也不清变量，
    // cloakbrowser 读到失效路径致 launch 失败难定位
    process.env[ENV_KEY] = join(tmp, 'deleted-chromium', 'chrome.exe')
    const { ensureLocalBinaryEnv } = await import('../browser/impl')
    ensureLocalBinaryEnv()
    expect(process.env[ENV_KEY]).toBeUndefined()
  })

  it('launch 前清除残留：ensureBrowser 后失效 env 不再存在且 launch 正常发起', async () => {
    process.env[ENV_KEY] = join(tmp, 'gone', 'chrome.exe')
    const bm = await getBrowserManager()
    await bm.ensureBrowser()
    expect(process.env[ENV_KEY]).toBeUndefined()
  })

  it('env 未设（非 win32）→ 保持未设不误设；win32 走探测链不抛错', async () => {
    delete process.env[ENV_KEY]
    const { ensureLocalBinaryEnv } = await import('../browser/impl')
    expect(() => ensureLocalBinaryEnv()).not.toThrow()
    if (process.platform !== 'win32') {
      expect(process.env[ENV_KEY]).toBeUndefined()
    }
  })
})
