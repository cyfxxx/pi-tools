/**
 * pi-browser tools/advanced — wait_for, network, select_option, dialog, download, upload, cookies
 */
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent'
import type { BrowserManager } from '../impl'
import type { RecordUsage } from '../helpers'
import { truncate, toolResult, createRequirePage } from '../helpers'

export function registerAdvancedTools(pi: ExtensionAPI, browser: BrowserManager, recordUsage: RecordUsage): void {
  const requirePage = createRequirePage(browser)

  // ─── browser_wait_for ─────────────────────────────────────
  pi.registerTool({
    name: 'browser_wait_for',
    label: '等待元素/网络',
    description:
      '等待页面元素出现或网络空闲，避免"页面未加载完/元素未就绪"导致的点击或提取失败。selector 为空时改为等待网络空闲。超时不抛错，返回是否命中。',
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
      'URL 过滤支持正则，如 url_pattern="api/"或"\\/users\\/\\d+"',
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
      '下载目录默认为系统临时目录下 pi-browser-downloads-<pid>（会话隔离，shutdown 自动清理），可传 dir 自定义',
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
}
