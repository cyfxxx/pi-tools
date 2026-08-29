import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { SessionScheduler } from './scheduler.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
import { acquireSessionLock, releaseSessionLock, renderPrompt, readTasks, updateTask, sendWebhook, withStoreLock, writeTasks, computeNextRun } from './storage.ts'
import { syncSeedTasks } from './seeds.ts'
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

    // 种子任务对账（2026-08-27）：补注册本地缺失的每日任务（跨设备通用定义见
    // agent/scheduled-seeds.json，git 入库；其他设备 pull 后启动即自动加入）
    try {
      const r = await syncSeedTasks()
      if (r.added > 0) console.log(`[pi-autopilot] 种子任务对账：注册 ${r.added} 个缺失任务`)
      if (r.drifted.length > 0) console.log(`[pi-autopilot] 种子漂移提醒（seeds 已更新，本地任务不覆盖，需手动同步）：${r.drifted.join('；')}｜详情 logs/scheduler/seed-drift.log`)
    } catch { /* 对账失败静默，不阻塞会话启动 */ }

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
          const noDelivery: string[] = []
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
              // 审计 MEDIUM 修复①（2026-08-25）：守卫 sendUserMessage 可用性——不可用时不
              // markInjected/不 clearPending/不推进 nextRun（保留到期态与 pendingInject 标记），
              // 下次 agent_settled 或重启时重试；对照 scheduler.fireViaMessage 的显式守卫。
              // 否则任务未交付却被闭环 success、once 任务被误删。
              if (typeof pi.sendUserMessage !== 'function') {
                noDelivery.push(task.name)
                continue
              }
              // 审计 MEDIUM 修复②（2026-08-25）：先推进 nextRun 再发送/clearPending——
              // tick 触发条件只有 isDue && !firing && !pendingInject（不查 injectedIds），
              // 若先 clearPending 会留下「pendingInject 已清、nextRun 仍过期」窗口供 tick 二次触发
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
              await pi.sendUserMessage(`[Scheduler] ${task.name}（上次会话中断，第 ${recovery} 次恢复注入）: ${renderPrompt(task.prompt)}`)
              // 审计 MEDIUM 修复（2026-08-18）：恢复注入同样登记 injectedIds——
              // 否则 agent_settled 的 finalizeInjected 不感知本路径（d323ab9 只补了
              // fireViaMessage 正常注入），once 任务恢复注入后永不删除、nextRun 缓冲
              // 到期再执行一次；interval 不回写 lastRun；notifyOnCompletion 不发 webhook
              scheduler.markInjected(task.id)
              await clearPending(task.id)
            } catch { /* ignore */ }
          }
          sections.push(`已重新注入 ${pending.length - deadLettered.length - noDelivery.length} 个中断时未完成的任务（可能重复执行）`)
          if (noDelivery.length > 0) {
            sections.push(`${noDelivery.length} 个待恢复任务因 sendUserMessage 不可用暂缓注入（保持到期态，下次结算/重启重试）: ${noDelivery.join('、')}`)
          }
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
      await clearAllPending(scheduler.injectingIds)
    } catch { /* 清理失败不阻塞 */ }
  })

  // 实测（2026-08-25）：宿主 _runAgentPrompt 的 finally 无条件发 agent_settled，
  // abort 回合也会闭环。在 agent_end 检查尾部 assistant stopReason==='aborted'
  // 回写给 scheduler，finalizeInjected 对中止回合仅推进 nextRun 不记 success。
  pi.on('agent_end', (event: { messages?: Array<{ role?: string; stopReason?: string }> }) => {
    const msgs = event?.messages ?? []
    const last = [...msgs].reverse().find((m) => m?.role === 'assistant')
    scheduler.markRunAborted(last?.stopReason === 'aborted')
  })

  registerCommands(pi, scheduler)
  registerTools(pi)
}
