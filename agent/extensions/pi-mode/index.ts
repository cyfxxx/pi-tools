import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerCommands } from './commands.ts'
import { getCurrentMode, getModeConfig, loadModes } from './config.ts'

/**
 * pi-mode 扩展：模式切换功能
 *
 * 提供三种预设模式：
 * - full: 完整模式，所有扩展和技能可用
 * - light: 轻量模式，只保留搜索、计划模式和基础工具
 * - quick: 极简模式，只保留内置工具，无扩展无技能
 *
 * 使用方式：
 * - 启动时: pi --mode <name> 或 pi -m <name>
 * - 运行时: /mode <name>
 * - 查看帮助: /mode help
 */
export default function piModeExtension(pi: ExtensionAPI): void {
  // 注册 /mode 命令
  registerCommands(pi)

  // 会话启动时显示当前模式信息
  pi.on('session_start', async (_event, ctx) => {
    // 检查环境变量（由 pi-wrapper.sh 设置）
    const envMode = process.env.PI_AGENT_MODE
    const modeName = envMode || getCurrentMode()

    if (!modeName || modeName === 'full') return // full 模式不提示

    const config = getModeConfig(modeName)
    if (!config) return

    // 在 TUI 顶部显示模式提示
    if (ctx.hasUI) {
      ctx.ui.notify(
        `[模式] ${modeName}: ${config.description}`,
        'info',
      )
    }
  })
}
