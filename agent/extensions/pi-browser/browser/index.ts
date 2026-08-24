import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback, AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { BrowserConfig } from './types'
import { BrowserManager } from './impl'
import { recordOutput, pruneToolOutput } from '../../../lib/prune.ts'
import { estimateTokens } from '../../../lib/token-budget.ts'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const REFERENCES_DIR = fileURLToPath(new URL('../references/', import.meta.url))
const INTERACTION_DOC = `${REFERENCES_DIR}interaction.md`

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
      return toolResult(resultText, "browser_navigate", recordUsage)
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
      const text = `截图已保存：\`${path}\`\n\n使用提示：观察截图中的目标元素位置，然后通过 browser_click 传入坐标进行点击。`
      return toolResult(text, "browser_screenshot", recordUsage)
    },
  })

  // ─── browser_click ───────────────────────────────────────────
  pi.registerTool({
    name: 'browser_click',
    label: '点击',
    description:
      '在页面中执行点击操作。支持两种模式：(1) 坐标模式 - 穿透 iframe/Shadow DOM/跨域框架，推荐配合截图使用；(2) 选择器模式 - 使用 CSS 选择器精准定位元素。注意：坐标是视口坐标，须以普通截图（full_page=false）量取，full_page 长截图会错位。',
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
        const text = `已在坐标 (${x}, ${y}) 处点击。`
        return toolResult(text, "browser_click", recordUsage)
      }
      await browser.clickSelector(sel!)
      const text = `已点击元素 "${sel}"。`
      return toolResult(text, "browser_click", recordUsage)
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
      const text = `${detail}（${(params.text as string).length} 字符）。`
      return toolResult(text, "browser_type", recordUsage)
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
      const text = `页面已${dir === 'up' ? '向上' : '向下'}滚动。`
      return toolResult(text, "browser_scroll", recordUsage)
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

  // ─── browser_wait_for ─────────────────────────────────────
  pi.registerTool({
    name: 'browser_wait_for',
    label: '等待元素/网络',
    description:
      '等待页面元素出现或网络空闲，避免“页面未加载完/元素未就绪”导致的点击或提取失败。selector 为空时改为等待网络空闲。超时不抛错，返回是否命中。',
    promptSnippet: '等待元素出现或网络空闲',
    promptGuidelines: [
      '页面加载慢或点击后元素未出现时先用本工具等待，再截图/点击',
      '命中返回 true，超时返回 false（不抛错），此时可用 browser_screenshot 看实际状态',
    ],
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '要等待的 CSS 选择器。为空时改为等待网络空闲。',
        },
        state: {
          type: 'string',
          enum: ['visible', 'attached', 'hidden', 'detached'],
          description: '等待的状态，默认 visible（元素可见）',
        },
        timeout: {
          type: 'number',
          description: '超时毫秒，默认 10000',
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
      const r = await browser.waitFor(params.selector as string | undefined, {
        state: (params.state as 'visible' | 'attached' | 'hidden' | 'detached' | undefined) ?? 'visible',
        timeout: params.timeout as number | undefined,
      })
      const t = params.timeout ?? 10000
      if (r.found) {
        const what = params.selector
          ? `元素 ${params.selector} 已就绪`
          : (r.marker === 'networkidle' ? '页面已加载（网络空闲）' : '页面已加载')
        return toolResult(`等待成功：${what}`, 'browser_wait_for', recordUsage)
      }
      const what = params.selector
        ? `元素 ${params.selector} 未在 ${t}ms 内达到 ${params.state ?? 'visible'}`
        : '页面未在超时内达到 networkidle'
      return toolResult(`等待超时：${what}。可重试或使用 browser_screenshot 检查当前状态。`, 'browser_wait_for', recordUsage)
    },
  })

  // ─── browser_network ───────────────────────────────────────
  pi.registerTool({
    name: 'browser_network',
    label: '网络请求日志',
    description:
      '查询浏览器记录的 HTTP 请求（URL/方法/资源类型/状态码），可按 URL/方法/类型过滤。用于分析页面调用的 API、抓取 JSON 数据接口。clear=true 可清空日志重新开始记录。',
    promptSnippet: '查询页面网络请求（接口/资源/状态码）',
    promptGuidelines: [
      '请求日志自页面打开即持续记录，倒序返回',
      '想抓某次操作触发的接口：先 clear=true 清空，再操作页面，再查询',
      'URL 过滤支持正则，如 url_pattern=“api/”或“\\/users\\/\\d+”',
    ],
    parameters: {
      type: 'object',
      properties: {
        url_pattern: {
          type: 'string',
          description: 'URL 过滤（正则或子串），如 "api/" 或 "\\/users\\/\\d+"',
        },
        method: {
          type: 'string',
          description: '请求方法过滤，如 GET / POST',
        },
        resource_type: {
          type: 'string',
          description: '资源类型过滤，如 fetch / xhr / document / image',
        },
        limit: {
          type: 'number',
          description: '返回条数上限，默认 100',
        },
        clear: {
          type: 'boolean',
          description: 'true 时清空日志并返回（用于开始新一轮记录）',
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
      if (params.clear) {
        browser.clearNetwork()
        return toolResult('网络日志已清空，后续请求将重新记录。', 'browser_network', recordUsage)
      }
      const entries = browser.getNetwork(
        {
          urlPattern: params.url_pattern as string | undefined,
          method: params.method as string | undefined,
          type: params.resource_type as string | undefined,
        },
        params.limit as number | undefined,
      )
      if (entries.length === 0) {
        return toolResult(
          '未捕获到匹配的网络请求。提示：日志自页面打开即持续记录；若需隔离新请求，先带 clear=true 清空再做操作。',
          'browser_network',
          recordUsage,
        )
      }
      const lines = entries.map(
        e => `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.status ?? '…'} ${e.method} ${e.type} ${e.url}`,
      )
      return toolResult(`网络请求日志（${entries.length} 条）：\n` + lines.join('\n'), 'browser_network', recordUsage)
    },
  })

  // ─── browser_select_option ──────────────────────────────────
  pi.registerTool({
    name: 'browser_select_option',
    label: '选择下拉选项',
    description:
      '在 <select> 下拉框中选择一个选项。默认按 value 匹配，by_label=true 时按可见文本匹配。若不确定选项值，可先用 browser_evaluate 查询。',
    promptSnippet: '选择下拉框中的选项',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '下拉框 <select> 的 CSS 选择器',
        },
        value: {
          type: 'string',
          description: '要选的选项 value（或 by_label=true 时的可见文本）',
        },
        by_label: {
          type: 'boolean',
          description: '是否按可见文本匹配，默认 false（按 value）',
        },
      },
      required: ['selector', 'value'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      await browser.selectOption(
        params.selector as string,
        params.value as string,
        params.by_label as boolean | undefined,
      )
      return toolResult(
        `已选择下拉框 ${params.selector} 的选项：${params.value}`,
        'browser_select_option',
        recordUsage,
      )
    },
  })

  // ─── browser_dialog ─────────────────────────────────────────
  pi.registerTool({
    name: 'browser_dialog',
    label: '设置弹窗策略',
    description:
      '设置页面 JavaScript 弹窗（alert/confirm/prompt）处理策略。默认 dismiss（自动取消，不阻塞）。accept=自动确认；input=以 text 填入 prompt 并确认。只传 mode 为空时，则返回最近一次捕获的弹窗文本。',
    promptSnippet: '设置或查询页面对话框处理策略',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['accept', 'dismiss', 'input'],
          description: '处理策略。省略时仅返回最近弹窗文本',
        },
        text: {
          type: 'string',
          description: 'mode=input 时填入 prompt 的文本',
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
      if (params.mode) {
        browser.setDialogMode(params.mode as 'accept' | 'dismiss' | 'input', params.text as string | undefined)
        const mode = params.mode as string
        const extra = mode === 'input' && params.text ? `（将输入：${params.text}）` : ''
        return toolResult(`弹窗策略已设为：${mode}${extra}`, 'browser_dialog', recordUsage)
      }
      const last = browser.getLastDialog()
      return toolResult(last ? `最近弹窗文本：${last}` : '最近未捕获到弹窗。', 'browser_dialog', recordUsage)
    },
  })

  // ─── browser_download ──────────────────────────────────────
  pi.registerTool({
    name: 'browser_download',
    label: '管理/查询下载',
    description:
      '查询浏览器会话中已触发并保存的下载文件（自页面打开持续监听，点击下载链接/按钮后自动保存）。可指定 dir 更改下载目录。返回已下载文件列表（文件名/路径/来源 URL）。',
    promptSnippet: '查询已下载的文件',
    promptGuidelines: [
      '点击下载按钮前无需预先调用，下载事件自动监听并保存',
      '触发下载后调用本工具（不带 dir）查看已保存的文件路径',
      '下载目录默认 ~/.pi-browser-downloads，可传 dir 自定义',
    ],
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: '设置/更改下载保存目录（可选）',
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
      const files = browser.downloads(params.dir as string | undefined)
      if (files.length === 0) {
        return toolResult('尚未捕获到下载。提示：下载事件自页面打开即自动监听并保存；可先触发下载（点击下载按钮/链接）再查询。', 'browser_download', recordUsage)
      }
      const lines = files.map(f => `- ${f.filename} \n  路径: ${f.path} \n  来源: ${f.url}`)
      return toolResult(`已下载 ${files.length} 个文件：\n` + lines.join('\n'), 'browser_download', recordUsage)
    },
  })

  // ─── browser_upload ────────────────────────────────────────
  pi.registerTool({
    name: 'browser_upload',
    label: '上传文件',
    description: '向页面的 <input type="file"> 选择器设置要上传的本地文件路径。用于表单文件上传场景。',
    promptSnippet: '向页面文件输入框选择本地文件',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '文件输入框 <input type="file"> 的 CSS 选择器',
        },
        path: {
          type: 'string',
          description: '要上传的本地文件绝对路径',
        },
      },
      required: ['selector', 'path'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      await browser.uploadFile(params.selector as string, params.path as string)
      return toolResult(`已将文件 ${params.path} 设置到 ${params.selector}`, 'browser_upload', recordUsage)
    },
  })

  // ─── browser_cookies ────────────────────────────────────────
  pi.registerTool({
    name: 'browser_cookies',
    label: '查看/设置 Cookie',
    description:
      '查看或设置页面的 cookie。action=get 返回当前域 cookie（name/value/domain）；action=set 需提供 url/name/value 新增一个 cookie。用于登录态检查或预置会话。',
    promptSnippet: '查看或设置页面 Cookie',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set'],
          description: 'get=读取当前页面 cookies；set=新增 cookie',
          default: 'get',
        },
        url: {
          type: 'string',
          description: 'action=set 时必填：cookie 所属 URL（如 https://example.com）',
        },
        name: {
          type: 'string',
          description: 'action=set 时必填：cookie 名',
        },
        value: {
          type: 'string',
          description: 'action=set 时必填：cookie 值',
        },
      },
      required: ['action'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      requirePage()
      const action = (params.action as string) || 'get'
      if (action === 'set') {
        if (!params.url || !params.name) {
          return toolResult('browser_cookies action=set 需要 url、name、value。', 'browser_cookies', recordUsage)
        }
        await browser.setCookie(params.url as string, params.name as string, params.value as string)
        return toolResult(`已新增 cookie：${params.name}=${params.value}（${params.url}）`, 'browser_cookies', recordUsage)
      }
      const cookies = await browser.getCookies(params.url as string | undefined)
      if (cookies.length === 0) return toolResult('当前域没有任何 cookie。', 'browser_cookies', recordUsage)
      const lines = cookies.map(c => `- ${c.name} = ${c.value} (${c.domain})`)
      return toolResult(`Cookies（${cookies.length} 个）：\n` + lines.join('\n'), 'browser_cookies', recordUsage)
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

  // ─── browser_pdf ────────────────────────────────────────────
  pi.registerTool({
    name: 'browser_pdf',
    label: '导出 PDF',
    description: '将当前页面打印为 PDF 并保存到本地路径（默认 /tmp/pi-browser-pdf/），返回文件路径。适用于导出页面为离线文档。',
    promptSnippet: '把当前页导出为 PDF',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'PDF 保存路径（可选，默认自动生成）',
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
      const path = await browser.exportPdf(params.path as string | undefined)
      return toolResult(`PDF 已导出：\`${path}\``, 'browser_pdf', recordUsage)
    },
  })

  // ─── browser_help ──────────────────────────────────────────
  pi.registerTool({
    name: 'browser_help',
    label: '浏览器交互手册',
    description:
      '查询 pi-browser 的 Web 交互手册（坐标转换、Shadow DOM、下拉框、弹窗、下载/上传、网络捕获、滚动、iframe、等待、cookie、截图），返回处理对应浏览器机制的实操要领。当页面交互不确定时按需查询。',
    promptSnippet: '查询浏览器交互机制手册（按需）',
    promptGuidelines: [
      '遇到坐标错位、shadow 元素点不到、下拉/弹窗/下载等不确定时先查对应主题',
      'topic 可选，如 shadow、dropdown、dialog、download、network、scroll、iframe、wait、cookie、screenshot',
    ],
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: '要查询的主题（可选）：shadow/dropdown/dialog/download/network/scroll/iframe/wait/cookie/screenshot 等',
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
      let doc: string
      try {
        doc = await readFile(INTERACTION_DOC, 'utf8')
      } catch {
        return toolResult('交互手册未找到（references/interaction.md 缺失）。', 'browser_help', recordUsage)
      }
      const topic = (params.topic as string | undefined)?.trim()
      if (topic) {
        // 按 '## <title>' 节提取，主题小写不敏感匹配
        const marker = `## ${topic}${topic.toLowerCase() === 'iframe' ? '' : ''}`
        const idx = doc.toLowerCase().indexOf(marker.toLowerCase())
        if (idx >= 0) {
          const rest = doc.slice(idx)
          const next = rest.search(/\n## /)
          const section = next > 0 ? rest.slice(0, next) : rest
          return toolResult(truncate(section.trim(), 3000), 'browser_help', recordUsage)
        }
        return toolResult(`未找到主题「${topic}」。可用主题见手册全文，标题包括：坐标/截图、Shadow DOM、下拉框、弹窗、下载、网络、滚动、iframe、等待、Cookie。\n\n${truncate(doc, 500)}`, 'browser_help', recordUsage)
      }
      return toolResult(truncate(doc, 8000), 'browser_help', recordUsage)
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
      const text = '浏览器实例已关闭，资源已释放。'
      return toolResult(text, "browser_close", recordUsage)
    },
  })
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + `\n\n…… [已截断，共 ${s.length} 字符]`
}

function toolResult(text: string, toolName: string, recordUsage?: RecordUsage): AgentToolResult<Record<string, unknown>> {
  const result = pruneToolOutput(text, toolName)
  recordOutput(toolName, result.length)
  if (recordUsage) recordUsage(toolName, estimateTokens(result))
  return { content: [{ type: 'text' as const, text: result }], details: {} }
}
