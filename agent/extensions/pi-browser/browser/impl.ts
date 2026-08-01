import type { Browser, Page } from 'playwright-core'
import type { BrowserConfig, PageInfo } from './types'

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
          '  bash ~/.pi/agent/extensions/pi-web-toolkit/install.sh\n' +
          '或手动安装依赖：\n' +
          '  cd ~/.pi/agent/extensions/pi-web-toolkit && npm install'
        )
      }
      throw e
    }

    const opts: Record<string, unknown> = {
      headless: this.config.headless,
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
    const page = await this.ensurePage()
    const errors: Error[] = []

    for (const waitUntil of ['networkidle', 'load'] as const) {
      try {
        const gotoOpts: Record<string, unknown> = { waitUntil, timeout: 30000 }
        if (signal) gotoOpts.signal = signal
        await page.goto(url, gotoOpts)
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
    const path = `/tmp/pi-screenshot-${Date.now()}.png`
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
