import type { Browser, Page } from 'playwright-core'
import type { BrowserConfig, PageInfo } from './types'
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
          '浏览器依赖未安装。请运行安装脚本：\n' +
          '  bash ~/.pi/agent/extensions/pi-browser/install.sh\n' +
          '或手动安装依赖：\n' +
          '  cd ~/.pi/agent/extensions/pi-browser && npm install'
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
  }
}
