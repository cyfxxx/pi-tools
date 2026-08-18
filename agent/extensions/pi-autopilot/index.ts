import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SessionScheduler } from './scheduler.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
import { acquireSessionLock, releaseSessionLock, renderPrompt, readTasks, updateTask, sendWebhook, withStoreLock, writeTasks, computeNextRun } from './storage.ts'
import { collectOfflineExecutions, formatSummary, markRead } from './notifications.ts'
import { consumeRestartLog } from './state.ts'
import { readAutopilotConfig } from './autoconfig.ts'
import { collectPendingTasks, clearPending, clearAllPending, wasAbnormalShutdown, MAX_RECOVERY_ATTEMPTS } from './queue.ts'
import { setTurnBusy, touchActivity } from './watchdog.ts'

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
          const deadLettered: string[] = []
          for (const task of pending) {
            try {
              // A2: 恢复次数上限（3 次）——连续崩溃后同一任务反复重注入会无限循环，
              // 超限转 dead-letter：暂停任务 + webhook 告警，需人工介入
              const recovery = (task.recoveryCount ?? 0) + 1
              if (recovery > MAX_RECOVERY_ATTEMPTS) {
                await updateTask(task.id, { enabled: false, recoveryCount: recovery })
                await sendWebhook(task, 'suspended', `恢复重试超限（${recovery} 次），任务已暂停，需人工介入`)
                deadLettered.push(task.name)
                continue
              }
              await updateTask(task.id, { recoveryCount: recovery })
              await pi.sendUserMessage?.(`[Scheduler] ${task.name}（上次会话中断，第 ${recovery} 次恢复注入）: ${renderPrompt(task.prompt)}`)
              // 审计 MEDIUM 修复（2026-08-18）：恢复注入同样登记 injectedIds——
              // 否则 agent_settled 的 finalizeInjected 不感知本路径（d323ab9 只补了
              // fireViaMessage 正常注入），once 任务恢复注入后永不删除、nextRun 缓冲
              // 到期再执行一次；interval 不回写 lastRun；notifyOnCompletion 不发 webhook
              scheduler.markInjected(task.id)
              await clearPending(task.id)
              // 审计 MEDIUM 修复：恢复注入后推进 nextRun——否则 nextRun 仍停留在
              // 过去（崩溃时任务正在执行），30s 后 tick 因 isDue 再次触发 → 双重执行
              await withStoreLock(async () => {
                const store = await readTasks()
                const t = store.tasks.find(x => x.id === task.id)
                if (t) {
                  let next = computeNextRun(t)
                  if (!next || new Date(next).getTime() <= Date.now()) {
                    next = new Date(Date.now() + 3600 * 1000).toISOString()
                  }
                  t.nextRun = next
                  await writeTasks(store)
                }
              })
            } catch { /* ignore */ }
          }
          sections.push(`已重新注入 ${pending.length - deadLettered.length} 个中断时未完成的任务（可能重复执行）`)
          if (deadLettered.length > 0) {
            sections.push(`已暂停 ${deadLettered.length} 个恢复超限任务（dead-letter）: ${deadLettered.join('、')}，需人工确认后 /schedule enable 恢复`)
          }
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

  // 回合边界维护挂死豁免：长静默工具执行期间不判挂死（审计：>30min 工具被误杀）
  pi.on('turn_start', async () => {
    setTurnBusy(true)
  })
  pi.on('turn_end', async () => {
    setTurnBusy(false)
  })

  // 主会话空闲（回合结束）＝注入的任务已执行完成：先最终化注入式任务
  // （once 删除 + webhook + 调度推进，补 d323ab9 审计修复的半闭环——此前
  // once 任务每小时重复注入、永不删除），再清除 pendingInject 标志。
  // 双作用：① interval 任务可再次触发（防重叠期间正确跳过）；② 崩溃恢复时
  // collectPendingTasks 只收集真正"注入后未完成"的任务。
  pi.on('agent_settled', async () => {
    // 兜底：turn_end 异常未发出时这里也解除豁免，防止 watchdog 永久静默
    setTurnBusy(false)
    try {
      await scheduler.finalizeInjected()
      await clearAllPending()
    } catch { /* 清理失败不阻塞 */ }
  })

  registerCommands(pi, scheduler)
  registerTools(pi)
}
