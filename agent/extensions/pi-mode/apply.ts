import type { ModeConfig } from './types.ts'

/**
 * 模式切换结果：记录哪些配置项被修改
 */
export interface ApplyResult {
  thinkingChanged: boolean
  needsRestart: boolean
  changes: string[]
}

/**
 * 运行时应用模式配置（工具过滤、思考级别）
 * 注意：扩展/技能/系统提示词只能在启动时通过 CLI 标志修改
 */
export function applyModeRuntime(
  config: ModeConfig,
  currentThinking: string | undefined,
): ApplyResult {
  const result: ApplyResult = {
    thinkingChanged: false,
    needsRestart: false,
    changes: [],
  }

  // 思考级别变更
  if (config.thinking && config.thinking !== currentThinking) {
    result.thinkingChanged = true
    result.changes.push(`思考级别: ${config.thinking}`)
  }

  // 标记需要重启的配置
  if (config.extensions.length > 0) {
    result.needsRestart = true
    result.changes.push(`扩展将在重启后生效`)
  }

  if (config.skills.length > 0) {
    result.needsRestart = true
    result.changes.push(`技能将在重启后生效`)
  }

  if (config.systemPrompt || config.appendSystemPrompt) {
    result.needsRestart = true
    result.changes.push(`系统提示词将在重启后生效`)
  }

  return result
}

/**
 * 检查模式配置是否需要重启才能生效
 */
export function needsRestart(config: ModeConfig): boolean {
  return (
    config.extensions.length > 0 ||
    config.skills.length > 0 ||
    config.systemPrompt !== null ||
    config.appendSystemPrompt !== null
  )
}
