/**
 * pi-browser tools/extraction — extract, evaluate, find
 */
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent'
import type { BrowserManager } from '../impl'
import type { RecordUsage } from '../helpers'
import { truncate, toolResult, createRequirePage } from '../helpers'

export function registerExtractionTools(pi: ExtensionAPI, browser: BrowserManager, recordUsage: RecordUsage): void {
  const requirePage = createRequirePage(browser)

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
          description: 'CSS 选择器，提取特定元素内的文本。如 "article"、".main-content"、"#result-stats"。留空提取整页。',
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
      return toolResult(truncated, "browser_extract", recordUsage)
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
          description: '要执行的 JavaScript 代码。返回值会被序列化为 JSON。例如：\n- 提取所有链接: document.querySelectorAll("a").map(a => a.href)\n- 获取页面元数据: JSON.stringify({title: document.title, url: location.href})',
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
      const str = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)
      const truncated = truncate(str, 5000)
      return toolResult(`执行结果：\n${truncated}`, "browser_evaluate", recordUsage)
    },
  })

  // ─── browser_find ───────────────────────────────────────────
  pi.registerTool({
    name: 'browser_find',
    label: 'Shadow DOM 定位',
    description:
      '在文档与所有 Shadow DOM 深层查找首个匹配 selector 的元素，返回其中心坐标（视口像素，可直接用于 browser_click）与文本摘要。适用于常规 CSS 选择器匹配不到 shadow-root 内元素的情况。',
    promptSnippet: '在 Shadow DOM 内定位元素并获取坐标',
    promptGuidelines: [
      '当 browser_click 的选择器模式匹配不到（元素在 shadow-root 内）时用本工具先定位',
      '返回的 x/y 可直接交给 browser_click 的坐标模式',
      '若返回 null 说明页面上无此选择器',
    ],
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '要查找的 CSS 选择器（穿透 Shadow DOM）',
        },
      },
      required: ['selector'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const found = await browser.findElement(params.selector as string)
      if (!found) {
        return toolResult(`未在文档或 Shadow DOM 中找到匹配 ${params.selector} 的元素。`, 'browser_find', recordUsage)
      }
      const text = found.text ? `\n文本: ${found.text}` : ''
      return toolResult(`命中 ${params.selector}，中心坐标 (${found.x}, ${found.y})${text}`, 'browser_find', recordUsage)
    },
  })
}
