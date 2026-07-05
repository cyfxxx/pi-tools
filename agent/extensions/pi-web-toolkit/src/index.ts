import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import { searchWeb } from './search'
import { BrowserManager } from './browser'
import type { ProxyPool } from './proxy-pool'
import type { WebToolkitConfig } from './types'
import { unlink, readdir } from 'fs/promises'
import { join } from 'path'
import { recordToolUsage, resetBudget, estimateTokens } from '../../../lib/token-budget.ts'

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max
    ? s
    : s.slice(0, max) + `\n\n…… [已截断，共 ${s.length} 字符]`
}

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

const SCREENSHOT_PREFIX = 'pi-screenshot-'
const MAX_SCREENSHOTS = 20

async function cleanScreenshots(): Promise<void> {
  try {
    const files = await readdir('/tmp')
    await Promise.all(
      files
        .filter(f => f.startsWith(SCREENSHOT_PREFIX))
        .map(f => unlink(join('/tmp', f)).catch(() => {}))
    )
  } catch { /* ignore */ }
}

async function trimScreenshots(): Promise<void> {
  try {
    const files = (await readdir('/tmp'))
      .filter(f => f.startsWith(SCREENSHOT_PREFIX))
      .sort()
    if (files.length > MAX_SCREENSHOTS) {
      await Promise.all(
        files
          .slice(0, files.length - MAX_SCREENSHOTS)
          .map(f => unlink(join('/tmp', f)).catch(() => {}))
      )
    }
  } catch { /* ignore */ }
}

export default async function (pi: ExtensionAPI) {
  const config: WebToolkitConfig = loadConfig()

  // Proxy pool: lazily imported + deferred init on first proxy tool use
  let proxyPool: ProxyPool | null = null
  let proxyPoolInit: Promise<void> | null = null
  if (config.proxy_pool) {
    const { ProxyPool: PP } = await import('./proxy-pool')
    proxyPool = new PP(config.proxy_pool) as unknown as ProxyPool
    proxyPoolInit = proxyPool.init().catch((e) => {
      console.error(`[pi-web-toolkit] 代理池启动失败: ${(e as Error).message}，IP 池功能不可用`)
      proxyPool = null
      proxyPoolInit = null
    })
  }
  async function ensureProxy(): Promise<boolean> {
    if (proxyPoolInit) { await proxyPoolInit; proxyPoolInit = null }
    return proxyPool !== null
  }

  // Pass proxy pool lazy getter — browser will resolve proxy URL only when launching
  const browser = new BrowserManager(config.browser, () => proxyPool?.getLocalProxyUrl() ?? null)

  // ─── web_search ─────────────────────────────────────────────
  pi.registerTool({
    name: 'web_search',
    label: '搜索网络',
    description:
      '使用 SearXNG 私密元搜索引擎搜索网络。支持指定搜索引擎列表、分类过滤、分页、时间范围。自动报告不可用的搜索引擎，支持引擎故障切换。',
    promptSnippet: '搜索网络，支持多引擎、分类、分页和时间范围过滤',
    promptGuidelines: [
      '国内网络推荐 engines: ["baidu","sogou","bing"]，境外用 ["google","bing","duckduckgo"]',
      '如搜索结果不理想，尝试减少 engines 参数或切换 categories',
      '默认返回 5 条结果，使用 max_results:N 查看更多, brief:true 只看标题列表',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        engines: {
          type: 'array',
          items: { type: 'string' },
          description:
            '指定搜索引擎列表，如 ["google","bing","duckduckgo","brave","qwant","startpage"]。留空则使用 SearXNG 默认配置。当网络环境变化时可切换引擎组合。',
        },
        categories: {
          type: 'string',
          enum: [
            'general',
            'news',
            'images',
            'videos',
            'files',
            'map',
            'music',
            'it',
            'science',
            'social media',
          ],
          description: '搜索类别，用于缩小搜索范围',
        },
        pageno: { type: 'number', description: '页码，从 1 开始。用于翻页查看更多结果。' },
        time_range: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: '时间范围过滤',
        },
        lang: {
          type: 'string',
          description: '语言代码，如 zh-CN、en-US、ja-JP。指定搜索结果的偏好语言。',
        },
        max_results: {
          type: 'number',
          description: '返回的最大结果数（默认 5）。设为 10 或 20 查看更多。设为 0 使用默认值。',
          default: 5,
        },
        brief: {
          type: 'boolean',
          description: '简要模式：只返回标题和 URL 列表，不包含 snippet。适合快速浏览。',
          default: false,
        },
      },
      required: ['query'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const text = await searchWeb(
        config.search,
        params.query as string,
        {
          engines: params.engines as string[] | undefined,
          categories: params.categories as string | undefined,
          pageno: params.pageno as number | undefined,
          time_range: params.time_range as string | undefined,
          lang: params.lang as string | undefined,
          max_results: params.max_results as number | undefined,
          brief: params.brief as boolean | undefined,
        },
        signal,
      )
      recordToolUsage('web_search', estimateTokens(text))
      return toolResult(text)
    },
  })

  // ─── browser_navigate ────────────────────────────────────────
  pi.registerTool({
    name: 'browser_navigate',
    label: '打开网页',
    description:
      '使用 CloakBrowser 隐身浏览器打开指定 URL，自动绕过反爬虫检测。返回页面标题、URL 和结构化摘要而非全文，大幅节省上下文。使用 browser_extract 获取完整文本。',
    promptSnippet: '打开网页，返回结构化摘要（标题、大纲、要点）',
    promptGuidelines: [
      '先 web_search 搜索到目标 URL，再用 browser_navigate 打开',
      '默认返回摘要而非全文以节省上下文，需要完整内容时用 browser_extract',
      '如页面加载慢会自动等待，请耐心',
    ],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的完整 URL（须包含协议，如 https://）' },
        extract_text: {
          type: 'string',
          enum: ['summary', 'full', 'none'],
          description: '文本提取模式: "summary"（摘要，默认）, "full"（完整文本）, "none"（不提取）',
          default: 'summary',
        },
      },
      required: ['url'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const info = await browser.navigate(params.url as string, signal)
      const lines: string[] = []
      lines.push(`页面标题: ${info.title}`)
      lines.push(`URL: ${info.url}`)
      lines.push(`视口: ${info.viewport.width}x${info.viewport.height}`)
      const extractMode = (params.extract_text as string) || 'summary'
      if (extractMode === 'full') {
        lines.push('')
        lines.push(truncate(info.textContent, 5000))
      } else if (extractMode === 'summary') {
        const smart = await browser.smartExtract()
        lines.push('')
        lines.push(`── 页面摘要 ──`)
        lines.push(smart.summary)
        if (smart.keyPoints.length > 0) {
          lines.push('')
          lines.push(`── 要点 ──`)
          for (const kp of smart.keyPoints) lines.push(`- ${kp}`)
        }
        const totalLen = smart.fullText.length
        lines.push('')
        lines.push(`[全文 ${totalLen} 字符。使用 browser_extract 获取完整内容]`)
      }
      const resultText = lines.join('\n')
      recordToolUsage('browser_navigate', estimateTokens(resultText))
      return toolResult(resultText)
    },
  })

  function requirePage(): void {
    if (!browser.isPageActive()) {
      throw new Error('尚未打开任何页面。请先调用 browser_navigate。')
    }
  }

  // ─── browser_screenshot ──────────────────────────────────────
  pi.registerTool({
    name: 'browser_screenshot',
    label: '截图',
    description:
      '截取当前浏览器页面的截图。截图保存到本地路径，LLM 可根据截图内容分析页面布局，随后使用 browser_click 的坐标模式进行精准点击。参考 browser-harness 截图驱动交互模式。',
    promptSnippet: '截取当前页面截图，用于分析布局后坐标点击',
    promptGuidelines: [
      '先 browser_navigate 打开页面，再用 browser_screenshot 截图',
      '分析截图后通过 browser_click(x, y) 进行坐标点击，可穿透 iframe/Shadow DOM',
    ],
    parameters: {
      type: 'object',
      properties: {
        full_page: {
          type: 'boolean',
          description: '是否截取整个页面（包含滚动区域外的内容）',
          default: false,
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const path = await browser.screenshot(params.full_page as boolean | undefined)
      return toolResult(`截图已保存：\`${path}\`\n\n使用提示：观察截图中的目标元素位置，然后通过 browser_click 传入坐标进行点击。`)
    },
  })

  // ─── browser_click ───────────────────────────────────────────
  pi.registerTool({
    name: 'browser_click',
    label: '点击',
    description:
      '在页面中执行点击操作。支持两种模式：(1) 坐标模式 - 穿透 iframe/Shadow DOM/跨域框架，推荐配合截图使用；(2) 选择器模式 - 使用 CSS 选择器精准定位元素。',
    promptSnippet: '坐标或选择器点击，坐标模式可穿透 iframe/Shadow DOM',
    promptGuidelines: [
      '推荐先 browser_screenshot 截图，分析后使用坐标模式 (x, y) 点击',
      '坐标模式可穿透所有嵌套层级，选择器模式用于简单元素',
    ],
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description:
            '点击位置的 X 坐标（像素）。与 y 同时提供时使用坐标模式。坐标模式可穿透所有嵌套层级。',
        },
        y: {
          type: 'number',
          description: '点击位置的 Y 坐标（像素）。与 x 同时提供时使用坐标模式。',
        },
        selector: {
          type: 'string',
          description:
            'CSS 选择器，如 "button#submit"、".search-btn"、"a[href*=\\"login\\"]"。与 x/y 互斥，二选一。',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标按键',
          default: 'left',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const x = params.x as number | undefined
      const y = params.y as number | undefined
      const sel = params.selector as string | undefined

      if (x == null && !sel) {
        throw new Error('请提供 x/y 坐标或 CSS selector 参数，二者选一。')
      }
      requirePage()
      const rawBtn = params.button as string | undefined
      const btn: 'left' | 'right' | 'middle' = rawBtn === 'right' ? 'right' : rawBtn === 'middle' ? 'middle' : 'left'
      if (x != null && y != null) {
        await browser.click(x, y, btn)
        return toolResult(`已在坐标 (${x}, ${y}) 处点击。`)
      }
      await browser.clickSelector(sel!)
      return toolResult(`已点击元素 "${sel}"。`)
    },
  })

  // ─── browser_type ────────────────────────────────────────────
  pi.registerTool({
    name: 'browser_type',
    label: '输入文本',
    description:
      '在页面中输入文本。可指定 CSS 选择器定位输入框，留空则在当前焦点元素中输入。推荐先点击目标输入框（使用 browser_click），再调用本工具。',
    promptSnippet: '在页面上输入文本，可指定或使用当前焦点元素',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本内容' },
        selector: {
          type: 'string',
          description:
            '目标输入框的 CSS 选择器，如 "#search"、"input[name=\\"q\\"]"。留空则在当前焦点元素输入。',
        },
      },
      required: ['text'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      await browser.typeText(params.text as string, params.selector as string | undefined)
      const detail = params.selector
        ? `向 "${params.selector}" 输入了文本`
        : '在当前焦点元素输入了文本'
      return toolResult(`${detail}（${(params.text as string).length} 字符）。`)
    },
  })

  // ─── browser_scroll ──────────────────────────────────────────
  pi.registerTool({
    name: 'browser_scroll',
    label: '滚动页面',
    description: '滚动当前页面。默认向下滚动一个视口高度（约 80% 视口）。',
    promptSnippet: '滚动页面，支持方向和指定像素数',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up'],
          description: '滚动方向',
          default: 'down',
        },
        amount: {
          type: 'number',
          description: '滚动像素数，为空则滚动一个视口高度',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const dir = (params.direction as string) ?? 'down'
      const amount = params.amount as number | undefined
      if (amount != null) {
        await browser.scroll(0, dir === 'up' ? -amount : amount)
      } else {
        const vh = config.browser.viewport_height
        await browser.scroll(0, dir === 'up' ? -vh : Math.floor(vh * 0.8))
      }
      return toolResult(`页面已${dir === 'up' ? '向上' : '向下'}滚动。`)
    },
  })

  // ─── browser_extract ─────────────────────────────────────────
  pi.registerTool({
    name: 'browser_extract',
    label: '提取内容',
    description:
      '提取当前页面的文本内容。可通过 CSS 选择器提取页面特定区域的内容，留空则提取整个页面的可见文本。',
    promptSnippet: '提取页面文本内容，可指定 CSS 选择器范围',
    promptGuidelines: [
      '留空 selector 提取整页文本，指定 selector 提取特定区域',
      '提取结果有 8000 字符上限，超长会被截断',
    ],
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description:
            'CSS 选择器，提取特定元素内的文本。如 "article"、".main-content"、"#result-stats"。留空提取整页。',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const content = await browser.extractContent(params.selector as string | undefined)
      const truncated = truncate(content, 8000)
      recordToolUsage('browser_extract', estimateTokens(truncated))
      return toolResult(truncated)
    },
  })

  // ─── browser_evaluate ────────────────────────────────────────
  pi.registerTool({
    name: 'browser_evaluate',
    label: '执行 JavaScript',
    description:
      '在浏览器页面中执行任意 JavaScript 代码，返回执行结果。用于高级 DOM 操作、数据提取、页面状态检查等。',
    promptSnippet: '在页面中执行 JavaScript 代码获取数据',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            '要执行的 JavaScript 代码。返回值会被序列化为 JSON。例如：\n- 提取所有链接: document.querySelectorAll("a").map(a => a.href)\n- 获取页面元数据: JSON.stringify({title: document.title, url: location.href})',
        },
      },
      required: ['script'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const result = await browser.evaluate(params.script as string)
      const str =
        typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)
      const truncated = truncate(str, 5000)
      recordToolUsage('browser_evaluate', estimateTokens(truncated))
      return toolResult(`执行结果：\n${truncated}`)
    },
  })

  // ─── browser_close ───────────────────────────────────────────
  pi.registerTool({
    name: 'browser_close',
    label: '关闭浏览器',
    description: '关闭当前浏览器实例，释放系统资源。在不再需要浏览器操作时调用。',
    promptSnippet: '关闭浏览器，释放系统资源',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await browser.close()
      return toolResult('浏览器实例已关闭，资源已释放。')
    },
  })

  // ─── IP 池工具（首次调用时初始化）────────────────────────────
  function registerProxyTools(): void {
    pi.registerTool({
      name: 'ip_pool_status',
      label: 'IP 池状态',
      description: '查看代理 IP 池的运行状态：代理总数、存活/失效数量、平均延迟、当前策略及各代理详情。',
      promptSnippet: '查看代理 IP 池运行状态和统计数据',
      parameters: { type: 'object', properties: {} },
      execute: async (
        _toolCallId: string,
        _params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ) => {
        if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
        const s = await proxyPool!.getStats()
        const lines: string[] = []
        lines.push(`IP 池状态 (策略: ${s.strategy})`)
        lines.push(`├─ 当前: ${s.current || 'none'}`)
        lines.push(`├─ 总计: ${s.total}`)
        lines.push(`├─ 存活: ${s.alive}`)
        lines.push(`├─ 失效: ${s.dead}`)
        lines.push(`└─ 平均延迟: ${s.avgLatency}ms`)
        lines.push('')
        for (const e of s.entries) {
          const icon = e.isCurrent ? '➡️' : '🟢'
          const lat = e.latency > 0 ? `${e.latency}ms` : '-'
          lines.push(`${icon} ${e.url}  延迟:${lat}  失败:${e.failures}`)
        }
        return toolResult(lines.join('\n'))
      },
    })

    pi.registerTool({
      name: 'ip_pool_add',
      label: '添加代理',
      description: '向 IP 池中添加一个或多个代理。支持 HTTP/HTTPS/SOCKS 协议，每行一个。',
      promptSnippet: '手动向 IP 池添加代理',
      parameters: {
        type: 'object',
        properties: {
          proxies: {
            type: 'array',
            items: { type: 'string' },
            description: '代理 URL 数组，如 ["http://user:pass@1.2.3.4:8080", "socks5://5.6.7.8:1080"]',
          },
        },
        required: ['proxies'],
      },
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ) => {
        if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
        const list = params.proxies as string[]
        await proxyPool!.addProxies(list)
        const s = await proxyPool!.getStats()
        return toolResult(`已添加 ${list.length} 个代理。当前池: ${s.alive}/${s.total} 存活，当前: ${s.current || 'none'}。`)
      },
    })

    pi.registerTool({
      name: 'ip_pool_rotate',
      label: '轮转 IP',
      description: '强制轮转当前代理 IP，切换至池中另一个可用代理。后续浏览器的网络请求将使用新 IP。',
      promptSnippet: '强制切换当前代理 IP',
      parameters: { type: 'object', properties: {} },
      execute: async (
        _toolCallId: string,
        _params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ) => {
        if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
        const p = await proxyPool!.rotate()
        if (p) return toolResult(`已轮转至代理: ${p}`)
        return toolResult('无可用的代理进行轮转。')
      },
    })
  }

  // Register proxy tools only if proxy_pool is configured (deferred init)
  const proxyConfigured = !!config.proxy_pool
  if (proxyConfigured) registerProxyTools()

  // ─── lifecycle ───────────────────────────────────────────────
  pi.on('session_shutdown', async () => {
    await browser.close()
    if (proxyPoolInit) await proxyPoolInit.catch(() => {})
    if (proxyPool) proxyPool.stop()
    await cleanScreenshots()
  })

  pi.on('session_compact', async () => {
    await trimScreenshots()
  })

  pi.on('session_start', async () => {
    resetBudget()
  })
}
