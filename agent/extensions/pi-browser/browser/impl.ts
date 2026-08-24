import type { Browser, Page } from 'playwright-core'
import type { BrowserConfig, PageInfo, NetworkEntry, DialogMode, DownloadFile } from './types'
import { existsSync, readdirSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

/** 截图暂存目录（os.tmpdir()：Linux=/tmp，Termux=$PREFIX/tmp；cleanScreenshots 同名清理） */
export function shotDir(): string {
  return join(tmpdir(), 'pi-browser-screenshots')
}

/**
 * Windows 便携版：cloakbrowser 走 CLOAKBROWSER_BINARY_PATH；未设时自动探测
 * 便携包内浏览器（优先官方 stealth 定制版 .cloakbrowser/chromium-<ver>/chrome.exe，
 * 回退 npmmirror tools/chrome-win64）——不依赖 start.bat wrapper 环境
 * （wrapper 循环内 set 不重跑）。非 win32 平台直接短路，零副作用。
 */
export function ensureLocalBinaryEnv(): void {
  // 环境变量已设且文件存在 → 直接使用；指向不存在的文件（如已删的旧 npmmirror）→ 重新探测
  if (process.env.CLOAKBROWSER_BINARY_PATH && existsSync(process.env.CLOAKBROWSER_BINARY_PATH)) return
  if (process.platform !== 'win32') return
  const root = process.env.USERPROFILE || homedir()
  // 官方定制版缓存目录（cloakbrowser 结构：.cloakbrowser/chromium-<ver>/chrome.exe）
  try {
    const cacheDir = join(root, '.cloakbrowser')
    if (existsSync(cacheDir)) {
      for (const entry of readdirSync(cacheDir)) {
        if (entry.startsWith('chromium-')) {
          const chrome = join(cacheDir, entry, 'chrome.exe')
          if (existsSync(chrome)) {
            process.env.CLOAKBROWSER_BINARY_PATH = chrome
            return
          }
        }
      }
    }
  } catch { /* 缓存目录不可读 → 回退 */ }
  // 回退：npmmirror chrome-for-testing
  const chrome = join(root, 'tools', 'chrome-win64', 'chrome.exe')
  if (existsSync(chrome)) {
    process.env.CLOAKBROWSER_BINARY_PATH = chrome
  }
}

export class BrowserManager {
  private browser: Browser | null = null
  private page: Page | null = null
  private config: BrowserConfig
  private getProxyUrl: (() => string | null) | null
  private initializing: Promise<Browser> | null = null
  private networkLog: NetworkEntry[] = []
  private dialogMode: DialogMode = 'dismiss'
  private dialogText: string | null = null
  private lastDialog: string | null = null
  private readonly MAX_NETWORK = 1000
  private downloadsDir = join(tmpdir(), 'pi-browser-downloads')
  private downloadedFiles: DownloadFile[] = []

  constructor(config: BrowserConfig, getProxyUrl?: () => string | null) {
    this.config = config
    this.getProxyUrl = getProxyUrl ?? null
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    if (this.initializing) return this.initializing

    this.initializing = this.launchBrowser().catch(e => {
      this.initializing = null
      throw e
    })
    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }

  private async launchBrowser(): Promise<Browser> {
    ensureLocalBinaryEnv()
    let launch: typeof import('cloakbrowser')['launch']
    try {
      launch = (await import('cloakbrowser')).launch
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND' ||
        (e as Error)?.message?.includes('Cannot find module')
      ) {
        throw new Error(
          '浏览器依赖未安装。请安装依赖：\n' +
          '  cd ~/.pi/agent/extensions/pi-browser && npm install\n' +
          '（并确保 Playwright 浏览器已下载，如 npx playwright install chromium）'
        )
      }
      throw e
    }

    const opts: Record<string, unknown> = {
      headless: this.config.headless,
      // Windows 便携版：Chrome 继承系统代理（无效/被墙代理 → ERR_NETWORK_ACCESS_DENIED）——强制直连
      ...(process.platform === 'win32' ? { args: ['--no-proxy-server'] } : {}),
    }

    if (this.config.fingerprint_seed) {
      opts.fingerprint = this.config.fingerprint_seed
    }
    const proxyUrl = this.getProxyUrl?.()
    if (proxyUrl) {
      opts.proxy = { server: proxyUrl }
    } else if (this.config.proxy) {
      opts.proxy = { server: this.config.proxy }
    }
    if (this.config.data_dir) {
      opts.userDataDir = this.config.data_dir
    }

    this.browser = await launch(opts)
    return this.browser
  }

  private async ensurePage(): Promise<Page> {
    await this.ensureBrowser()
    if (this.page && !this.page.isClosed()) return this.page

    this.page = await this.browser!.newPage()
    await this.page.setViewportSize({
      width: this.config.viewport_width,
      height: this.config.viewport_height,
    })

    // 网络请求监听：持续记录最近 MAX_NETWORK 条，供 browser_network 查询
    // （特性检测：单测 mock 的 page 可能无 on，真实 playwright Page 必带）
    const pg = this.page as (Page & { on?: unknown }) | null
    if (pg && typeof pg.on === 'function') {
      pg.on('request', (req) => {
        if (this.networkLog.length >= this.MAX_NETWORK) this.networkLog.shift()
        this.networkLog.push({
          url: req.url(),
          method: req.method(),
          type: req.resourceType(),
          timestamp: Date.now(),
        })
      })
      pg.on('response', (res) => {
        // 回填最近一条相同 url 且尚未有 status 的条目（倒序避免覆盖同名后续请求）
        for (let i = this.networkLog.length - 1; i >= 0; i--) {
          if (this.networkLog[i].url === res.url() && this.networkLog[i].status === undefined) {
            this.networkLog[i].status = res.status()
            break
          }
        }
      })
      // 弹窗策略：默认 dismiss（避免阻塞），可经 browser_dialog 改为 accept/input。
      pg.on('dialog', async (dialog) => {
        this.lastDialog = dialog.message()
        if (this.dialogMode === 'accept') {
          await dialog.accept()
        } else if (this.dialogMode === 'input') {
          await dialog.accept(this.dialogText ?? '')
        } else {
          await dialog.dismiss()
        }
      })
      // 下载监听：保存到 downloadsDir，记录到 downloadedFiles
      pg.on('download', (download) => {
        const filename = download.suggestedFilename()
        this.saveDownload(download, filename).catch(err => {
          console.warn('[browser] download save error:', (err as Error)?.message)
        })
      })
    }

    return this.page
  }

  async navigate(url: string, signal?: AbortSignal): Promise<PageInfo> {
    // 审计 MEDIUM：URL 协议校验——prompt 注入场景下导航 file:// 可读取本地文件内容
    // 并经 extract_text 回传。只允许 http/https；内网地址保留（本地服务/开发测试合法用途）。
    try {
      const proto = new URL(url).protocol
      if (proto !== 'http:' && proto !== 'https:') {
        throw new Error(`协议不支持: ${proto}//（仅允许 http/https，拒绝 ${url.slice(0, 60)}）`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('协议不支持')) throw e
      throw new Error(`无效 URL: ${String(url).slice(0, 80)}`)
    }
    const page = await this.ensurePage()
    const errors: Error[] = []

    for (const waitUntil of ['networkidle', 'load'] as const) {
      try {
        const gotoOpts: Record<string, unknown> = { waitUntil, timeout: 30000 }
        if (signal) gotoOpts.signal = signal
        await page.goto(url, gotoOpts)
        // 审计 MEDIUM 修复：校验最终落地 URL（重定向后）——初始协议校验可被
        // 302 → file:// 等绕过；Chromium 默认拦 http→file 顶层跳转，此处为纵深防御。
        // about:blank 是浏览器初始空页（未导航/mock 未同步），排除在拒绝外
        const finalUrl = page.url()
        if (finalUrl && finalUrl !== 'about:blank') {
          try {
            const fp = new URL(finalUrl).protocol
            if (fp !== 'http:' && fp !== 'https:') {
              throw new Error(`重定向到不允许的协议: ${fp}//（浏览器已拦截 ${finalUrl.slice(0, 60)}）`)
            }
          } catch {
            throw new Error(`导航失败: 无效的最终 URL ${String(finalUrl).slice(0, 80)}`)
          }
        }
        return this.getPageInfo()
      } catch (e) {
        if (signal?.aborted) throw new Error('导航已取消')
        errors.push(e as Error)
      }
    }

    throw new Error(`导航失败: ${errors.map(e => e.message).join('; ')}`)
  }

  async getPageInfo(): Promise<PageInfo> {
    const page = await this.ensurePage()
    return {
      url: page.url(),
      title: await page.title(),
      content: await page.content(),
      textContent: await page.evaluate(() => document.body?.innerText?.trim() ?? ''),
      viewport: page.viewportSize() ?? { width: 1280, height: 800 },
    }
  }

  async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    const page = await this.ensurePage()
    await page.mouse.click(x, y, { button })
  }

  async clickSelector(selector: string): Promise<void> {
    const page = await this.ensurePage()
    const el = await page.$(selector)
    if (!el) throw new Error(`未找到元素: ${selector}`)
    const box = await el.boundingBox()
    if (!box) throw new Error(`元素不可见: ${selector}`)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  async typeText(text: string, selector?: string): Promise<void> {
    const page = await this.ensurePage()
    if (selector) {
      await page.fill(selector, text)
    } else {
      await page.keyboard.type(text, { delay: 10 })
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const page = await this.ensurePage()
    await page.evaluate(
      ({ dx, dy }: { dx: number; dy: number }) => window.scrollBy(dx, dy),
      { dx: deltaX, dy: deltaY },
    )
  }

  async screenshot(fullPage: boolean = false): Promise<string> {
    const page = await this.ensurePage()
    const dir = shotDir()
    await mkdir(dir, { recursive: true })
    const path = join(dir, `pi-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    await page.screenshot({ path, fullPage })
    return path
  }

  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensurePage()
    return page.evaluate(expression)
  }

  async extractContent(selector?: string): Promise<string> {
    const page = await this.ensurePage()
    if (selector) {
      return page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        return el?.textContent?.trim() ?? ''
      }, selector)
    }
    return page.evaluate(() => document.body?.innerText?.trim() ?? '')
  }

  async smartExtract(task?: string): Promise<{ summary: string; keyPoints: string[]; fullText: string }> {
    const page = await this.ensurePage()
    const fullText = await page.evaluate(() => document.body?.innerText?.trim() ?? '')

    const structured = await page.evaluate(() => {
      const text = document.body?.innerText?.trim() ?? ''
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => ({ tag: h.tagName, text: (h as HTMLElement).innerText?.trim() }))
        .filter(h => h.text)

      const paragraphs = Array.from(document.querySelectorAll('p, li, td, blockquote'))
        .map(el => (el as HTMLElement).innerText?.trim())
        .filter(t => t && t.length > 20)

      return { text: text.slice(0, 2000), headings: headings.slice(0, 15), paragraphs: paragraphs.slice(0, 30) }
    })

    const summary = [
      ...structured.headings.map(h => `${h.tag === 'H1' ? '# ' : h.tag === 'H2' ? '## ' : '### '}${h.text}`),
      '',
      ...structured.paragraphs.slice(0, 5).map(p => p.slice(0, 200)),
    ].join('\n')

    const keyPoints = structured.headings
      .filter(h => h.tag !== 'H1')
      .map(h => h.text!)
      .slice(0, 8)

    return { summary, keyPoints, fullText }
  }

  isPageActive(): boolean {
    if (!this.browser || !this.browser.isConnected()) return false
    if (!this.page || this.page.isClosed()) return false
    return true
  }

  /** 等待：selector 到位或网络空闲。命中返回 true，超时返回 false（不抛错）。 */
  async waitFor(
    selector?: string,
    opts: { state?: 'visible' | 'attached' | 'hidden' | 'detached'; timeout?: number } = {},
  ): Promise<{ found: boolean; marker?: string }> {
    const page = await this.ensurePage()
    const timeout = opts.timeout ?? 10000
    if (selector) {
      const state = opts.state ?? 'visible'
      try {
        await page.waitForSelector(selector, { state, timeout })
        return { found: true }
      } catch {
        return { found: false }
      }
    }
    try {
      await page.waitForLoadState('networkidle', { timeout })
      return { found: true, marker: 'networkidle' }
    } catch {
      return { found: false }
    }
  }

  /** 下拉框选择。byLabel=true 时按可见文本匹配，否则按 value。 */
  async selectOption(selector: string, value: string, byLabel: boolean = false): Promise<void> {
    const page = await this.ensurePage()
    const el = await page.$(selector)
    if (!el) throw new Error(`未找到下拉框: ${selector}`)
    await page.selectOption(selector, byLabel ? { label: value } : value)
  }

  /** 设置弹窗处理策略：accept 自动确认 / dismiss 自动取消 / input 以文本填入 prompt。 */
  setDialogMode(mode: DialogMode, text?: string): void {
    this.dialogMode = mode
    this.dialogText = mode === 'input' ? (text ?? '') : (text ?? null)
  }

  /** 最近一次弹窗文本（无弹窗则 null）。 */
  getLastDialog(): string | null {
    return this.lastDialog
  }

  /** 查询网络日志，支持 URL/方法/资源类型过滤，倒序返回最近 limit 条。 */
  getNetwork(
    filter?: { urlPattern?: string; method?: string; type?: string },
    limit: number = 100,
  ): NetworkEntry[] {
    let entries = this.networkLog
    if (filter?.urlPattern && filter.urlPattern) {
      try {
        entries = entries.filter(e => new RegExp(filter.urlPattern!).test(e.url))
      } catch {
        entries = entries.filter(e => e.url.includes(filter.urlPattern!))
      }
    }
    if (filter?.method) entries = entries.filter(e => e.method.toUpperCase() === filter.method!.toUpperCase())
    if (filter?.type) entries = entries.filter(e => e.type === filter.type)
    return entries.slice(-limit).reverse()
  }

  /** 清空网络日志（browser_network 设置 clear=true 时调用）。 */
  clearNetwork(): void {
    this.networkLog = []
  }

  /** 设置下载目录（可选）；返回已记录的所有下载文件。 */
  downloads(dir?: string): DownloadFile[] {
    if (dir) this.downloadsDir = dir
    return this.downloadedFiles.map(f => ({ ...f }))
  }

  private async saveDownload(download: import('playwright-core').Download, filename: string): Promise<void> {
    await mkdir(this.downloadsDir, { recursive: true })
    // 避免重名覆盖
    let target = join(this.downloadsDir, filename)
    const stamp = Date.now()
    const existing = this.downloadedFiles.find(f => f.filename === filename)
    if (existing) {
      const dot = filename.lastIndexOf('.')
      const base = dot > 0 ? filename.slice(0, dot) : filename
      const ext = dot > 0 ? filename.slice(dot) : ''
      target = join(this.downloadsDir, `${base}-${stamp}${ext}`)
      filename = `${base}-${stamp}${ext}`
    }
    await download.saveAs(target)
    this.downloadedFiles.push({ filename, path: target, url: download.url(), timestamp: Date.now() })
  }

  /** 上传文件到 <input type=file>。 */
  async uploadFile(selector: string, path: string): Promise<void> {
    const page = await this.ensurePage()
    await page.setInputFiles(selector, path)
  }

  /** 读取当前页面域（或给定 url）的 cookies。 */
  async getCookies(url?: string): Promise<{ name: string; value: string; domain: string }[]> {
    const page = await this.ensurePage()
    const cs = await page.context().cookies(url)
    return cs.map(c => ({ name: c.name, value: c.value, domain: c.domain }))
  }

  /** 为给定 url 添加一个 cookie。 */
  async setCookie(url: string, name: string, value: string): Promise<void> {
    const page = await this.ensurePage()
    await page.context().addCookies([{ name, value, url }])
  }

  /**
   * Shadow DOM 穿透定位：深层查找首个匹配 selector 的元素，
   * 返回其中心坐标（视口像素，可直接用于 browser_click）与文本摘要。
   * 找不到返回 null。
   */
  async findElement(selector: string): Promise<{ x: number; y: number; text: string } | null> {
    const page = await this.ensurePage()
    const found = await page.evaluate((sel: string) => {
      const hasText = (el: Element): boolean => el.id === sel || el.className === sel || el.nodeName.toLowerCase() === sel
      // 收集所有 shadow 根内与文档内的元素
      const candidates: Element[] = []
      const walk = (root: Document | ShadowRoot) => {
        for (const el of Array.from(root.querySelectorAll(sel))) candidates.push(el)
        // 遍历各层 shadow 根
        for (const el of Array.from(root.querySelectorAll('*'))) {
          const sr = (el as HTMLElement).shadowRoot
          if (sr) walk(sr)
        }
      }
      walk(document)
      if (candidates.length === 0) return null
      const el = candidates[0] as HTMLElement
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        text: (el.textContent ?? '').trim().slice(0, 200),
      }
    }, selector)
    return (found as { x: number; y: number; text: string } | null) ?? null
  }

  /** 打印当前页为 PDF，返回保存路径。仅 Chromium 支持。 */
  async exportPdf(path?: string): Promise<string> {
    const page = await this.ensurePage()
    const dir = join(tmpdir(), 'pi-browser-pdf')
    await mkdir(dir, { recursive: true })
    const target = path ?? join(dir, `pi-page-${Date.now()}.pdf`)
    await page.pdf({ path: target, printBackground: true })
    return target
  }


  async close(): Promise<void> {
    // 竞态修复：launch 进行中时 close 必须等待其完成，否则 close 返回后
    // launch 才完成并赋值 this.browser，浏览器进程泄漏。
    // launch 失败（reject）无需关闭，静默吞掉。
    if (this.initializing) {
      try {
        await this.initializing
      } catch {
        // launch 失败：无浏览器可关
      }
    }
    try {
      if (this.page && !this.page.isClosed()) await this.page.close()
    } catch (e) {
      console.warn('[browser] page close error:', (e as Error).message)
    }
    try {
      if (this.browser) await this.browser.close()
    } catch (e) {
      console.warn('[browser] browser close error:', (e as Error).message)
    }
    this.page = null
    this.browser = null
    this.networkLog = []
    this.lastDialog = null
    this.dialogMode = 'dismiss'
    this.dialogText = null
    this.downloadedFiles = []
  }
}
