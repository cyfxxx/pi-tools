import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SessionScheduler } from './scheduler.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
import { acquireSessionLock, releaseSessionLock, renderPrompt, readTasks } from './storage.ts'
import { collectOfflineExecutions, formatSummary, markRead } from './notifications.ts'
import { consumeRestartLog } from './state.ts'
import { readAutopilotConfig } from './autoconfig.ts'
import { collectPendingTasks, clearPending, clearAllPending, wasAbnormalShutdown } from './queue.ts'
import { touchActivity } from './watchdog.ts'

export default function piAutopilotExtension(pi: ExtensionAPI): void {
  let scheduler = new SessionScheduler(pi)
  let notified = false
  let requeued = false

  pi.on('session_start', async () => {
    const config = await readAutopilotConfig()

    // 会话锁（防多实例）
    const locked = await acquireSessionLock()
    if (!locked) {
      console.warn('[pi-autopilot] 无法获取调度锁，另一个 Pi 实例可能已持有')
      return
    }

    scheduler.start()
    touchActivity()

    // 统一恢复报告：重启原因 + 离线执行摘要 + 挂死恢复 + 任务重注入
    if (!notified) {
      notified = true
      const sections: string[] = []

      const restartLog = consumeRestartLog()
      if (restartLog && restartLog.action !== 'none') {
        const reason = restartLog.reason || '(未指定原因)'
        let line = `系统已重启。操作: ${restartLog.action} | 原因: ${reason}`
        if (restartLog.targetModel) line += ` | 目标模型: ${restartLog.targetProvider}/${restartLog.targetModel}`
        sections.push(line)
      }

      const entries = await collectOfflineExecutions()
      if (entries.length > 0) {
        const summary = formatSummary(entries)
        if (summary) sections.push(`离线期间任务执行:\n${summary}`)
      }

      if (config.enabled && config.requeueOnRestart) {
        const abnormal = await wasAbnormalShutdown()
        const pending = await collectPendingTasks()
        if (abnormal && pending.length > 0 && !requeued) {
          requeued = true
          for (const task of pending) {
            try {
              await pi.sendUserMessage?.(`[Scheduler] ${task.name}（上次会话中断，重新注入）: ${renderPrompt(task.prompt)}`)
              await clearPending(task.id)
            } catch { /* ignore */ }
          }
          sections.push(`已重新注入 ${pending.length} 个中断时未完成的任务（可能重复执行）`)
        }
      }

      if (sections.length > 0) {
        const msg = sections.join('\n\n')
        try {
          await pi.sendUserMessage?.(msg)
        } catch { /* not critical */ }
      }

      // 摘要注入后标记已读
      for (const e of entries) {
        await markRead(e)
      }
    }
  })

  pi.on('session_shutdown', async () => {
    scheduler.stop()
    await releaseSessionLock()
  })

  // 用户输入视为活动：正常对话/挂机不应被挂死判定重启
  pi.on('input', async () => {
    touchActivity()
  })

  // 主会话空闲（回合结束）＝注入的任务已执行完成：清除 pendingInject 标记。
  // 双作用：① interval 任务可再次触发（防重叠期间正确跳过）；② 崩溃恢复时
  // collectPendingTasks 只收集真正"注入后未完成"的任务。
  pi.on('agent_settled', async () => {
    try {
      await clearAllPending()
    } catch { /* 清理失败不阻塞 */ }
  })

  registerCommands(pi, scheduler)
  registerTools(pi)
}
