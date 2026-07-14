import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SessionScheduler } from './scheduler.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
import { acquireSessionLock, releaseSessionLock } from './storage.ts'
import { collectOfflineExecutions, formatSummary } from './notifications.ts'

export default function piSchedulerExtension(pi: ExtensionAPI): void {
  let scheduler: SessionScheduler | null = null
  let notified = false

  pi.on('session_start', async () => {
    const locked = await acquireSessionLock()
    if (!locked) {
      console.warn('[pi-scheduler] 无法获取调度锁，另一个 Pi 实例可能已持有')
      return
    }

    if (!scheduler) {
      scheduler = new SessionScheduler(pi)
    }
    scheduler.start()

    if (!notified) {
      notified = true
      const entries = await collectOfflineExecutions()
      if (entries.length > 0) {
        const summary = formatSummary(entries)
        if (summary) {
          try {
            await pi.appendEntry?.({
              role: 'user',
              content: summary,
            })
          } catch { /* not critical */ }
        }
      }
    }
  })

  pi.on('session_shutdown', async () => {
    if (scheduler) {
      scheduler.stop()
      scheduler = null
    }
    await releaseSessionLock()
  })

  registerCommands(pi)
  registerTools(pi)
}
