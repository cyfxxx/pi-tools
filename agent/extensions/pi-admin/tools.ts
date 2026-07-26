import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readSettings, readModels, listAvailableModels, updateModelConfig, updateSettings, getSettingsPath } from './config.ts'
import { listSessions, resolveSession, getSessionsBaseDir } from './sessions.ts'
import { writeRestartRequest } from './state.ts'

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return /key|token|secret|password|auth/i.test(lower)
}

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'admin_status',
    label: 'Agent 状态',
    description: '查看当前 Agent 的运行时状态：当前模型/Provider、当前会话文件、运行模式、配置摘要、是否有待处理的重启操作。',
    parameters: { type: 'object', properties: {} },
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const settings = readSettings()
      const models = readModels()
      const sessionFile = ctx.sessionManager?.getSessionFile?.() || '(未知)'

      const sections: string[] = [
        'Agent 状态',
        `  运行模式: ${ctx.mode || '未知'}`,
        `  当前 Provider: ${settings.defaultProvider || '未设置'}`,
        `  当前模型: ${settings.defaultModel || '未设置'}`,
        `  会话文件: ${sessionFile}`,
        `  思考层级: ${settings.defaultThinkingLevel || '未设置'}`,
        `  Provider 总数: ${models.providers ? Object.keys(models.providers).length : 0}`,
      ]

      return {
        content: [{ type: 'text', text: sections.join('\n') }],
      }
    },
  })

  pi.registerTool({
    name: 'admin_list_models',
    label: '列出可用模型',
    description: '列出 models.json 中所有可用的 Provider 及其模型列表，包含模型 ID、上下文窗口大小等信息。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const providers = listAvailableModels()
      if (!providers.length) {
        return { content: [{ type: 'text', text: '(未找到可用模型)' }] }
      }

      const lines: string[] = ['可用模型列表:']
      for (const p of providers) {
        lines.push(`\n[${p.name}]`)
        if (p.baseUrl) lines.push(`  API: ${p.api || '未知'} | Base URL: ${p.baseUrl}`)
        for (const m of p.models) {
          const ctx = m.contextWindow ? `ctx:${m.contextWindow}` : ''
          const maxT = m.maxTokens ? `max:${m.maxTokens}` : ''
          const reas = m.reasoning ? '思考' : ''
          const tags = [ctx, maxT, reas].filter(Boolean).join(' ')
          lines.push(`  - ${m.id}${m.name ? ` (${m.name})` : ''}${tags ? ` [${tags}]` : ''}`)
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  pi.registerTool({
    name: 'admin_set_model',
    label: '切换模型',
    description: '切换默认模型和 Provider。会更新 settings.json 并立即重启 Agent 以加载新模型。重启后自动恢复当前会话。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider 名称，如 "local-llama"' },
        model: { type: 'string', description: '模型 ID，如 "Qwen3.6-35B-HauhauCS-Q4_K_P.gguf"' },
      },
      required: ['provider', 'model'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const provider = params.provider as string
      const model = params.model as string
      const result = updateModelConfig(provider, model)
      if (!result.success) {
        return { content: [{ type: 'text', text: result.error || '设置失败' }], isError: true }
      }

      const confirmed = ctx.hasUI
        ? await ctx.ui.confirm('切换模型', `将切换为 ${provider}/${model}，需要重启 Agent。是否继续？`)
        : true

      if (!confirmed) {
        return { content: [{ type: 'text', text: `已保存配置但未重启。下次启动将使用 ${provider}/${model}` }] }
      }

      writeRestartRequest('set_model', {
        targetProvider: provider,
        targetModel: model,
        reason: `切换模型为 ${provider}/${model}`,
      })

      try { ctx.shutdown() } catch { process.exit(0) }

      return { content: [{ type: 'text', text: `正在重启以加载模型 ${provider}/${model}...` }] }
    },
  })

  pi.registerTool({
    name: 'admin_get_config',
    label: '读取配置',
    description: '读取 settings.json 的配置项。不传 key 时返回全部配置。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '配置键名（可选），不传则返回全部' },
      },
    },
    execute: async (_toolCallId, params) => {
      const settings = readSettings()
      const key = params.key as string | undefined

      if (key) {
        const val = settings[key]
        const valStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2)
        return {
          content: [{ type: 'text', text: `${key}: ${valStr}` }],
        }
      }

      const { apiKey: _ak, ...safe } = settings as Record<string, unknown>
      return {
        content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
      }
    },
  })

  pi.registerTool({
    name: 'admin_set_config',
    label: '修改配置',
    description: '修改 settings.json 中的配置项。支持修改任何配置字段。敏感字段（如含 key/token/secret 的字段）需用户确认。修改立即生效，部分字段需重启后生效。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '配置键名，如 "defaultThinkingLevel"' },
        value: { type: 'string', description: '配置值（字符串）。对于数组或对象字段会自动解析 JSON。' },
      },
      required: ['key', 'value'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const key = params.key as string
      const rawValue = params.value as string

      let parsedValue: unknown = rawValue
      if (rawValue === 'true') parsedValue = true
      else if (rawValue === 'false') parsedValue = false
      else if (/^\d+$/.test(rawValue)) parsedValue = parseInt(rawValue, 10)
      else if (/^\d+\.\d+$/.test(rawValue)) parsedValue = parseFloat(rawValue)
      else if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
        try { parsedValue = JSON.parse(rawValue) } catch { /* keep as string */ }
      }

      if (isSensitiveKey(key) && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          '修改敏感配置',
          `确认修改 "${key}" 为 ${JSON.stringify(parsedValue)}？`,
        )
        if (!ok) {
          return { content: [{ type: 'text', text: '已取消' }] }
        }
      }

      const result = updateSettings(key, parsedValue)
      if (!result.success) {
        return { content: [{ type: 'text', text: result.error || '写入失败' }], isError: true }
      }

      return {
        content: [{ type: 'text', text: `已更新配置: ${key} = ${JSON.stringify(parsedValue)}` }],
      }
    },
  })

  pi.registerTool({
    name: 'admin_list_sessions',
    label: '列出会话',
    description: '列出当前工作目录下（或全部）的会话文件。返回会话 ID、文件路径、大小、修改时间、首行摘要。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '工作目录（可选），不传时列出全部会话目录' },
      },
    },
    execute: async (_toolCallId, params) => {
      const cwd = params.cwd as string | undefined
      const sessions = listSessions(cwd)

      if (!sessions.length) {
        return { content: [{ type: 'text', text: `(未找到会话${cwd ? ` 在 ${cwd}` : ''})` }] }
      }

      const lines: string[] = [`会话列表 (${sessions.length} 个，按修改时间倒序):`]
      for (const s of sessions.slice(0, 30)) {
        const sizeKB = (s.sizeBytes / 1024).toFixed(1)
        const mtime = new Date(s.mtimeMs).toISOString().slice(0, 19)
        lines.push(`  ${s.sessionId}  [${sizeKB} KB] [${mtime}]`)
        lines.push(`    路径: ${s.filePath}`)
        lines.push(`    摘要: ${s.firstLinePreview}`)
      }
      if (sessions.length > 30) {
        lines.push(`  ... 以及 ${sessions.length - 30} 个更多会话`)
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  pi.registerTool({
    name: 'admin_switch_session',
    label: '切换会话',
    description: '切换到指定的会话文件。支持按 sessionId 前缀匹配或直接指定文件路径。需要重启 Agent 以加载目标会话，重启后自动进入该会话。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '会话 ID（支持前缀匹配）或 .jsonl 文件路径' },
        reason: { type: 'string', description: '切换原因（可选）' },
      },
      required: ['target'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const target = params.target as string
      const reason = params.reason as string | undefined

      const session = resolveSession(target)
      if (!session) {
        return { content: [{ type: 'text', text: `未找到匹配的会话: ${target}` }], isError: true }
      }

      const confirmed = ctx.hasUI
        ? await ctx.ui.confirm('切换会话', `将切换到会话 ${session.sessionId} (${session.filePath})，需要重启 Agent。是否继续？`)
        : true

      if (!confirmed) {
        return { content: [{ type: 'text', text: '已取消会话切换' }] }
      }

      writeRestartRequest('switch_session', {
        targetSession: session.filePath,
        reason: reason || `切换到会话 ${session.sessionId}`,
      })

      try { ctx.shutdown() } catch { process.exit(0) }

      return { content: [{ type: 'text', text: `正在切换到会话 ${session.sessionId}...` }] }
    },
  })

  pi.registerTool({
    name: 'admin_restart',
    label: '重启 Agent',
    description: '重启 Agent 程序。当前会话会自动保存，重启后通过 --continue 自动恢复并继续执行任务。如果不需要重启，请拒绝此调用。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '重启原因（可选），会在重启后的恢复消息中显示' },
      },
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const reason = params.reason as string | undefined

      writeRestartRequest('restart', { reason: reason || '用户请求重启' })

      try { ctx.shutdown() } catch { process.exit(0) }

      return { content: [{ type: 'text', text: '正在重启...' }] }
    },
  })
}