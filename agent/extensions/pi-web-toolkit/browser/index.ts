import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback, ToolResult } from '@earendil-works/pi-coding-agent'
import type { BrowserConfig } from './types'
import { BrowserManager } from './impl'
import { recordOutput, pruneToolOutput } from '../../../lib/prune.ts'

type RecordUsage = (name: string, tokens: number) => void

export function registerBrowserTools(pi: ExtensionAPI, browser: BrowserManager, recordUsage: RecordUsage, viewportHeight: number = 800): void {
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
      recordUsage('browser_navigate', estimateTokens(resultText))
      return toolResult(resultText, "browser_navigate")
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
      return toolResult(`截图已保存：\`${path}\`\n\n使用提示：观察截图中的目标元素位置，然后通过 browser_click 传入坐标进行点击。`, "browser_screenshot")
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
          description: '点击位置的 X 坐标（像素）。与 y 同时提供时使用坐标模式。坐标模式可穿透所有嵌套层级。',
        },
        y: {
          type: 'number',
          description: '点击位置的 Y 坐标（像素）。与 x 同时提供时使用坐标模式。',
        },
        selector: {
          type: 'string',
          description: 'CSS 选择器，如 "button#submit"、".search-btn"、"a[href*=\\"login\\"]"。与 x/y 互斥，二选一。',
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
        return toolResult(`已在坐标 (${x}, ${y}) 处点击。`, "browser_click")
      }
      await browser.clickSelector(sel!)
      return toolResult(`已点击元素 "${sel}"。`, "browser_click")
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
          description: '目标输入框的 CSS 选择器，如 "#search"、"input[name=\\"q\\"]"。留空则在当前焦点元素输入。',
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
      return toolResult(`${detail}（${(params.text as string).length} 字符）。`, "browser_type")
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
        const vh = viewportHeight
        await browser.scroll(0, dir === 'up' ? -vh : Math.floor(vh * 0.8))
      }
      return toolResult(`页面已${dir === 'up' ? '向上' : '向下'}滚动。`, "browser_scroll")
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
      recordUsage('browser_extract', estimateTokens(truncated))
      return toolResult(truncated, "browser_extract")
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
      recordUsage('browser_evaluate', estimateTokens(truncated))
      return toolResult(`执行结果：\n${truncated}`, "browser_evaluate")
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
      return toolResult('浏览器实例已关闭，资源已释放。', "browser_close")
    },
  })
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + `\n\n…… [已截断，共 ${s.length} 字符]`
}

function toolResult(text: string, toolName: string): ToolResult {
  const result = pruneToolOutput(text, toolName)
  recordOutput(toolName, result.length)
  return { content: [{ type: 'text' as const, text: result }], details: {} }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
