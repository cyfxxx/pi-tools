import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import type { SearchOnlyConfig } from './types'
import { registerSearchTools } from './search/index'
import { recordToolUsage, resetBudget, estimateTokens } from '../../lib/token-budget.ts'
import { recordOutput, pruneToolOutput } from '../../lib/prune.ts'
import { searchDirect } from './fetch.ts'

export default async function (pi: ExtensionAPI) {
  const config: SearchOnlyConfig = loadConfig()

  // 分块读取响应体，最多读 cap 字节（防大文件全量入内存）
  async function readBodyLimited(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
    if (!res.body) {
      return { text: await res.text(), truncated: false }
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value.subarray(0, Math.min(value.length, cap - total)))
      total += Math.min(value.length, cap - total)
    }
    if (total >= cap) {
      // 恰好读满 cap：再读一块判断是否真有剩余（防 truncated 标记误报）；
      // 无论是否有剩余都 cancel()，避免连接悬挂
      try {
        const { done } = await reader.read()
        truncated = !done
      } catch {
        truncated = true
      }
      try { await reader.cancel() } catch { /* 流已结束 */ }
    }
    return { text: Buffer.concat(chunks).toString('utf-8'), truncated }
  }

  // Register feature tools
  registerSearchTools(pi, config.search, recordToolUsage)

  // ─── fetch_url: 轻量 HTTP GET（无需浏览器） ─────────────────────
  pi.registerTool({
    name: "fetch_url",
    label: "获取 URL",
    description: "使用 HTTP GET 获取 URL 内容（纯文本/API/JSON/Markdown）。需 JavaScript 渲染的页面用 browser_navigate。",
    promptSnippet: "获取网页内容",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 URL（含协议）" },
        max_length: { type: "number", description: "最大返回字符数，默认 8000" },
      },
      required: ["url"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const url = params.url as string
      const maxLength = Math.max(0, Math.min((params.max_length as number) ?? 8000, 200000))
      const controller = new AbortController()
      // 用户停止生成也应中断请求（_signal 转发）；两信号任一触发即 abort
      const onUserAbort = () => controller.abort()
      signal?.addEventListener?.('abort', onUserAbort)
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)" },
        })
        if (!res.ok) {
          // 取消未消费的响应体，避免连接悬挂
          try { await res.body?.cancel() } catch { /* 已释放 */ }
          return { content: [{ type: "text", text: `HTTP ${res.status}: ${res.statusText}` }], details: {} }
        }
        const { text, truncated: bodyTruncated } = await readBodyLimited(res, 512 * 1024)
        const truncated = text.length > maxLength
          ? text.slice(0, maxLength) + `\n\n...（共 ${text.length} 字符，仅显示前 ${maxLength} 字符）`
          : text
        const suffix = bodyTruncated ? `\n\n[响应体超过 512KB 已截断读取]` : ''
        const result = pruneToolOutput(truncated + suffix, "fetch_url")
        recordOutput("fetch_url", result.length)
        recordToolUsage("fetch_url", estimateTokens(result))
        return { content: [{ type: "text", text: result }], details: {} }
      } catch (e) {
        return { content: [{ type: "text", text: `请求失败: ${(e as Error).message}` }], details: {} }
      } finally {
        clearTimeout(timeout)  // fetch 抛错也清超时（防定时器空挂）
        signal?.removeEventListener?.('abort', onUserAbort)
      }
    },
  })

  // ─── web_fetch: 轻量 HTTP 搜索（不依赖 SearXNG） ────────────────
  pi.registerTool({
    name: "web_fetch",
    label: "网络搜索",
    description: "使用 HTTP GET 从搜索引擎获取结果。不依赖 SearXNG，适合搜索不可用时的 fallback。",
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
      try {
        const text = await searchDirect(query, maxResults)
        const result = pruneToolOutput(text, "web_fetch")
        recordOutput("web_fetch", result.length)
        recordToolUsage("web_fetch", estimateTokens(result))
        return { content: [{ type: "text", text: result }], details: {} }
      } catch (e) {
        // 网络/DNS/超时 abort 统一转友好错误（与 fetch_url 一致），不抛未处理拒绝
        return { content: [{ type: "text", text: `搜索失败: ${(e as Error).message}` }], details: {} }
      }
    },
  })

  // ─── lifecycle ───────────────────────────────────────────────
  pi.on('session_start', async () => {
    resetBudget()
    const { resetOutputBudget } = await import('../../lib/prune.ts')
    resetOutputBudget()
  })
}
