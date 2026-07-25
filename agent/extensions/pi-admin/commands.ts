import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readSettings, listAvailableModels, updateSettings, getSettingsPath } from './config.ts'
import { listSessions, resolveSession, getSessionsBaseDir } from './sessions.ts'
import { writeRestartRequest } from './state.ts'

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('admin:status', {
    description: '显示 Agent 当前状态：模型、会话、配置等。',
    usage: '/admin:status',
    handler: async (_args, ctx) => {
      const settings = readSettings()
      const sessionFile = ctx.sessionManager?.getSessionFile?.() || '(未知)'

      ctx.ui.notify(
        [
          'pi-admin',
          `  模式: ${ctx.mode || '未知'}`,
          `  Provider: ${settings.defaultProvider || '未设置'}`,
          `  模型: ${settings.defaultModel || '未设置'}`,
          `  会话: ${sessionFile}`,
          `  思考层级: ${settings.defaultThinkingLevel || '未设置'}`,
          `  配置文件: ${getSettingsPath()}`,
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('admin:restart', {
    description: '重启 Agent。自动保存当前会话，重启后恢复。',
    usage: '/admin:restart [reason]',
    handler: async (args, ctx) => {
      const reason = args.trim() || '用户请求重启'

      const confirmed = await ctx.ui.confirm('重启 Agent', `确认重启？\n原因: ${reason}`)
      if (!confirmed) return

      ctx.ui.notify('正在重启...', 'info')
      writeRestartRequest('restart', { reason })
      try { ctx.shutdown() } catch { process.exit(0) }
    },
  })

  pi.registerCommand('admin:session', {
    description: '切换到指定会话。需要重启。',
    usage: '/admin:session <sessionId|filePath>',
    handler: async (args, ctx) => {
      const target = args.trim()
      if (!target) {
        ctx.ui.notify('用法: /admin:session <sessionId|filePath>', 'error')
        return
      }

      const session = resolveSession(target)
      if (!session) {
        ctx.ui.notify(`未找到匹配的会话: ${target}`, 'error')
        return
      }

      const confirmed = await ctx.ui.confirm(
        '切换会话',
        `切换到会话 ${session.sessionId}\n${session.filePath}？将重启 Agent。`,
      )
      if (!confirmed) return

      ctx.ui.notify(`正在切换到会话 ${session.sessionId}...`, 'info')
      writeRestartRequest('switch_session', {
        targetSession: session.filePath,
        reason: `切换到会话 ${session.sessionId}`,
      })
      try { ctx.shutdown() } catch { process.exit(0) }
    },
  })

  pi.registerCommand('admin:model', {
    description: '切换模型。用法: /admin:model <provider> <model>',
    usage: '/admin:model <provider> <model>',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      if (parts.length < 2) {
        const providers = listAvailableModels()
        const hint = providers.map(p =>
          `  ${p.name}: ${p.models.map(m => m.id).join(', ')}`
        ).join('\n')
        ctx.ui.notify(`用法: /admin:model <provider> <model>\n可用模型:\n${hint}`, 'error')
        return
      }

      const provider = parts[0]
      const model = parts.slice(1).join(' ')

      const providers = listAvailableModels()
      const providerData = providers.find(p => p.name === provider)
      if (!providerData) {
        ctx.ui.notify(`Provider "${provider}" 不存在`, 'error')
        return
      }
      const modelExists = providerData.models.some(m => m.id === model)
      if (!modelExists) {
        ctx.ui.notify(`模型 "${model}" 不在 ${provider} 的列表中`, 'error')
        return
      }

      const confirmed = await ctx.ui.confirm(
        '切换模型',
        `将切换为 ${provider}/${model}，需要重启 Agent。是否继续？`,
      )
      if (!confirmed) return

      ctx.ui.notify(`正在切换模型为 ${provider}/${model}...`, 'info')
      updateSettings('defaultProvider', provider)
      updateSettings('defaultModel', model)
      writeRestartRequest('set_model', {
        targetProvider: provider,
        targetModel: model,
        reason: `切换模型为 ${provider}/${model}`,
      })
      try { ctx.shutdown() } catch { process.exit(0) }
    },
  })

  pi.registerCommand('admin:config', {
    description: '读取或修改配置。不传值时读取，传值时修改。',
    usage: '/admin:config <key> [value]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      if (!parts.length || !parts[0]) {
        ctx.ui.notify('用法: /admin:config <key> [value]', 'error')
        return
      }

      const key = parts[0]
      const value = parts.slice(1).join(' ')

      if (!value) {
        const settings = readSettings()
        const val = settings[key]
        const valStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2)
        ctx.ui.notify(`${key}: ${valStr}`, 'info')
        return
      }

      let parsedValue: unknown = value
      if (value === 'true') parsedValue = true
      else if (value === 'false') parsedValue = false
      else if (/^\d+$/.test(value)) parsedValue = parseInt(value, 10)
      else if (/^\d+\.\d+$/.test(value)) parsedValue = parseFloat(value)
      else if (value.startsWith('[') || value.startsWith('{')) {
        try { parsedValue = JSON.parse(value) } catch { /* keep as string */ }
      }

      const sensitive = /key|token|secret|password|auth/i.test(key)
      if (sensitive) {
        const ok = await ctx.ui.confirm('修改敏感配置', `确认修改 "${key}" 为 ${JSON.stringify(parsedValue)}？`)
        if (!ok) return
      }

      const result = updateSettings(key, parsedValue)
      if (!result.success) {
        ctx.ui.notify(result.error || '写入失败', 'error')
        return
      }

      ctx.ui.notify(`已更新配置: ${key} = ${JSON.stringify(parsedValue)}`, 'success')
    },
  })
}