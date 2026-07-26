import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerTools } from './tools.ts'
import { registerCommands } from './commands.ts'
import { consumeRestartLog } from './state.ts'

export default function piAdminExtension(pi: ExtensionAPI): void {
  registerTools(pi)
  registerCommands(pi)

  pi.on('session_start', async () => {
    const log = consumeRestartLog()
    if (log && log.action !== 'none') {
      const reason = log.reason || '(未指定原因)'
      const lines: string[] = [
        `系统已重启。`,
        `操作: ${log.action} | 原因: ${reason}`,
      ]
      if (log.targetSession) lines.push(`目标会话: ${log.targetSession}`)
      if (log.targetModel) lines.push(`目标模型: ${log.targetProvider}/${log.targetModel}`)
      lines.push(`会话已恢复，请继续之前的任务。`)

      const msg = lines.join('\n')
      console.log(`[pi-admin] ${msg}`)

      try {
        pi.sendMessage({
          customType: 'admin_restart_notice',
          content: msg,
          display: true,
        })
      } catch {
        // non-critical
      }
    }
  })
}