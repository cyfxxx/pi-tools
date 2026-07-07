import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import type { WebToolkitConfig } from './types'
import type { ProxyPool } from './proxy/pool'
import { BrowserManager } from './browser/impl'
import { registerSearchTools } from './search/index'
import { registerBrowserTools } from './browser/index'
import { registerProxyControlTools } from './proxy/index'
import { unlink, readdir } from 'fs/promises'
import { join } from 'path'
import { recordToolUsage, resetBudget, estimateTokens } from '../../lib/token-budget.ts'
import { recordOutput, pruneToolOutput } from '../../lib/prune.ts'
import { searchDirect } from './fetch.ts'

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
    const { ProxyPool: PP } = await import('./proxy/pool')
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

  // Register feature tools
  registerSearchTools(pi, config.search, recordToolUsage)
  registerBrowserTools(pi, browser, recordToolUsage, config.browser.viewport_height)

  const proxyConfigured = !!config.proxy_pool
  if (proxyConfigured) {
    registerProxyControlTools(pi, ensureProxy, proxyPool)
  }

  // ─── fetch_url: 轻量 HTTP GET（无需浏览器） ─────────────────────
  pi.registerTool({
    name: "fetch_url",
    label: "获取 URL",
    description: "使用 HTTP GET 获取 URL 内容。适用于纯文本、API 响应、JSON、Markdown 文档。需要 JavaScript 渲染的页面请用 browser_navigate。",
    promptSnippet: "获取网页内容",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 URL（含协议）" },
        max_length: { type: "number", description: "最大返回字符数，默认 8000" },
      },
      required: ["url"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const url = params.url as string
      const maxLength = (params.max_length as number) ?? 8000
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15000)
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)" },
        })
        clearTimeout(timeout)
        if (!res.ok) {
          return { content: [{ type: "text", text: `HTTP ${res.status}: ${res.statusText}` }] }
        }
        const text = await res.text()
        const truncated = text.length > maxLength
          ? text.slice(0, maxLength) + `\n\n...（共 ${text.length} 字符，仅显示前 ${maxLength} 字符）`
          : text
        const result = pruneToolOutput(truncated, "fetch_url")
        recordOutput("fetch_url", result.length)
        return { content: [{ type: "text", text: result }] }
      } catch (e) {
        return { content: [{ type: "text", text: `请求失败: ${(e as Error).message}` }] }
      }
    },
  })

  // ─── web_fetch: 轻量 HTTP 搜索（不依赖 SearXNG） ────────────────
  pi.registerTool({
    name: "web_fetch",
    label: "网络搜索",
    description: "使用 HTTP GET 从搜索引擎获取搜索结果。不依赖 SearXNG 服务，适合搜索不可用时的 fallback。",
    promptSnippet: "网络搜索",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "number", description: "最大返回结果数，默认 5" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = params.query as string
      const maxResults = (params.max_results as number) ?? 5
      const text = await searchDirect(query, maxResults)
      const result = pruneToolOutput(text, "web_fetch")
      recordOutput("web_fetch", result.length)
      return { content: [{ type: "text", text: result }] }
    },
  })

  // ─── lifecycle ───────────────────────────────────────────────
  pi.on('session_shutdown', async () => {
    await browser.close()
    if (proxyPool) proxyPool.stop()
    await cleanScreenshots()
  })

  pi.on('session_compact', async () => {
    await trimScreenshots()
  })

  pi.on('session_start', async () => {
    resetBudget()
    const { resetOutputBudget } = await import('../../lib/prune.ts')
    resetOutputBudget()
  })
}
