import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  loadModes,
  setCurrentMode,
  getModeConfig,
  getCurrentMode,
  listModeNames,
  getDefaultMode,
} from './config.ts'
import { applyModeRuntime, needsRestart } from './apply.ts'

const MODE_HELP = `用法:
  /mode              显示当前模式
  /mode list         列出所有可用模式
  /mode <name>       切换到指定模式
  /mode help         显示本帮助

可用模式:
  full    完整模式 - 所有扩展和技能可用
  light   轻量模式 - 只保留搜索、计划模式和基础工具
  quick   极简模式 - 只保留内置工具，无扩展无技能

示例:
  /mode light        切换到轻量模式
  /mode full         切换回完整模式

注意:
  扩展/技能/系统提示词变更需要重启 pi 才能生效。
  工具和思考级别可立即生效。

自定义模式:
  编辑 ~/.pi/agent/modes.json 添加自定义模式配置。`

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('mode', {
    description: '查看/切换当前模式（/mode help 查看用法）',
    getArgumentCompletions: () => {
      const names = listModeNames()
      return names.map((name) => ({
        value: name,
        label: name,
        description: getModeConfig(name)?.description || '',
      }))
    },
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || ''

      // help
      if (subcmd === 'help' || subcmd === '-h' || subcmd === '--help') {
        ctx.ui.notify(MODE_HELP, 'info')
        return
      }

      // list
      if (subcmd === 'list') {
        const modes = loadModes()
        const lines: string[] = ['可用模式:', '']
        for (const [name, config] of Object.entries(modes.modes)) {
          const current = name === modes.current ? ' (当前)' : ''
          const extCount = config.extensions.filter((e) => !e.startsWith('!')).length
          const skillCount = config.skills.filter((s) => !s.startsWith('!') && !s.startsWith('-')).length
          const needs = needsRestart(config)
          lines.push(`  ${name}${current}: ${config.description}`)
          lines.push(`    覆盖: ${extCount} 扩展, ${skillCount} 技能${needs ? ' [需重启]' : ''}`)
        }
        lines.push('')
        lines.push('使用 /mode <name> 切换模式')
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      // 无参数：显示当前模式
      if (!subcmd) {
        const currentName = getCurrentMode()
        const config = getModeConfig(currentName)
        const defaultMode = getDefaultMode()
        ctx.ui.notify(
          `当前模式: ${currentName}\n` +
          `描述: ${config?.description ?? '未知'}\n` +
          `默认模式: ${defaultMode}\n\n` +
          `使用 /mode <name> 切换模式，/mode list 查看所有模式，/mode help 查看帮助`,
          'info',
        )
        return
      }

      // 切换模式
      const modeName = subcmd
      const config = getModeConfig(modeName)
      if (!config) {
        const available = listModeNames().join(', ')
        ctx.ui.notify(
          `未知模式: "${modeName}"\n可用模式: ${available}\n\n使用 /mode list 查看详细信息，/mode help 查看帮助`,
          'error',
        )
        return
      }

      // 获取当前思考级别用于比较
      const currentThinking =
        typeof (pi as any).getThinkingLevel === 'function'
          ? (pi as any).getThinkingLevel()
          : undefined

      // 更新 modes.json
      setCurrentMode(modeName)

      // 应用运行时可变的配置
      const result = applyModeRuntime(config, currentThinking)

      // 思考级别立即生效
      if (result.thinkingChanged && config.thinking) {
        if (typeof (pi as any).setThinkingLevel === 'function') {
          try {
            ;(pi as any).setThinkingLevel(config.thinking)
          } catch {
            // 切换失败不阻塞
          }
        }
      }

      // 报告切换结果
      const lines: string[] = [`已切换到模式: ${modeName}`]
      if (config.description) {
        lines.push(`描述: ${config.description}`)
      }
      if (result.needsRestart) {
        lines.push('')
        lines.push('以下配置将在重启 pi 后生效:')
        for (const change of result.changes) {
          lines.push(`  - ${change}`)
        }
        lines.push('')
        lines.push('请使用 /exit 退出后重新启动 pi')
      } else if (result.thinkingChanged) {
        lines.push(`思考级别已调整为: ${config.thinking}`)
      } else {
        lines.push('无需重启，配置已生效')
      }

      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}
