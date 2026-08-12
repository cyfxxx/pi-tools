import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  listTasks, isDue, updateTaskAfterRun, readTasks, renderPrompt, sendWebhook, updateTask,
} from './storage.ts'
import type { Task } from './types.ts'
import { readAutopilotConfig } from './autoconfig.ts'
import { decide, classifyError, currentModel } from './policy.ts'
import { planFailover, executeFailover } from './failover.ts'
import { appendRun, estimateCost } from './telemetry.ts'
import { checkBudget } from './budget.ts'
import { triggerHangRecovery, touchActivity } from './watchdog.ts'
import { markPendingInjected } from './queue.ts'

export class SessionScheduler {
  private pi: ExtensionAPI
  private timer: ReturnType<typeof setInterval> | null = null
  private firing = new Set<string>()

  constructor(pi: ExtensionAPI) {
    this.pi = pi
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 30000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.firing.clear()
  }

  /** 立即执行任务（/loop 创建后首次触发用） */
  async runNow(task: Task): Promise<void> {
    if (this.firing.has(task.id)) return
    await this.fireTask(task)
  }

  private async tick(): Promise<void> {
    try {
      const config = await readAutopilotConfig()
      const store = await readTasks()
      if (store.settings.paused) return

      // 看门狗：挂死检测
      if (config.enabled && (await triggerHangRecovery(config.maxIdleMinutes))) {
        try { (this.pi as unknown as { shutdown?: () => void }).shutdown?.() } catch { /* ignore */ }
        process.exit(0)
      }

      const tasks = await listTasks()
      // pendingInject=true 表示任务已注入主会话仍可能执行中（fireViaMessage 非阻塞），
      // 过滤掉防 interval 长任务重叠触发（agent_settled 时统一清除）
      const due = tasks.filter(t => isDue(t) && !this.firing.has(t.id) && !t.pendingInject)
      for (const task of due) {
        if (this.firing.has(task.id)) continue
        await this.fireTask(task)
      }
    } catch { /* suppress tick errors */ }
  }

  private async fireTask(task: Task): Promise<void> {
    this.firing.add(task.id)
    const startedAt = Date.now()
    const config = await readAutopilotConfig()
    const { provider, model } = currentModel()

    try {
      // 预算检查
      if (config.enabled) {
        const b = await checkBudget(config.budget, model)
        if (!b.allowed) {
          await sendWebhook(task, 'skipped', `预算限制: ${b.reason}`)
          await appendRun({
            ts: new Date().toISOString(), taskId: task.id, taskName: task.name,
            model, provider, result: 'failed', durationMs: 0, outputLen: 0, estCost: 0,
            errClass: 'unknown',
          })
          return
        }
      }

      if (task.useSubagent) {
        await this.fireViaSubagent(task, provider, model)
      } else {
        await this.fireViaMessage(task, provider, model)
      }
      await updateTaskAfterRun(task.id, 'success', '', Date.now() - startedAt)
      await appendRun({
        ts: new Date().toISOString(), taskId: task.id, taskName: task.name,
        model, provider, result: 'success', durationMs: Date.now() - startedAt,
        outputLen: 0, estCost: estimateCost(provider, model, task.prompt.length, 0),
        errClass: null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const exitCode = (err as { exitCode?: number }).exitCode ?? 1
      const outputLen = (err as { outputLen?: number }).outputLen ?? 0
      const errClass = classifyError(message, exitCode)

      await appendRun({
        ts: new Date().toISOString(), taskId: task.id, taskName: task.name,
        model, provider, result: 'failed', durationMs: Date.now() - startedAt,
        outputLen, estCost: estimateCost(provider, model, task.prompt.length, outputLen),
        errClass,
      })

      const action = decide(task, errClass, config.policy, config.fallbackModels, {
        stderr: message,
        exitCode,
        promptLen: task.prompt.length,
        outputLen,
        durationMs: Date.now() - startedAt,
      })

      switch (action.type) {
        case 'retry':
        case 'fail':
          await updateTaskAfterRun(task.id, 'failed', action.note, Date.now() - startedAt)
          break
        case 'failover': {
          const plan = await planFailover(config.fallbackModels, provider, model)
          await updateTaskAfterRun(task.id, 'failed', `failover: ${action.note}`, Date.now() - startedAt)
          if (!plan.target) break
          await sendWebhook(task, 'failed', `触发 failover → ${plan.target.provider}/${plan.target.model}: ${plan.reason}`)
          const msg = await executeFailover(plan.target, plan.reason, false)
          console.log(`[pi-autopilot] ${msg}`)
          try { (this.pi as unknown as { shutdown?: () => void }).shutdown?.() } catch { /* ignore */ }
          process.exit(0)
          break
        }
        case 'suspend_task':
          await updateTask(task.id, { enabled: false })
          await updateTaskAfterRun(task.id, 'failed', action.note, Date.now() - startedAt)
          await sendWebhook(task, 'suspended', action.note)
          break
      }
    } finally {
      this.firing.delete(task.id)
    }
  }

  private async fireViaMessage(task: Task, _provider: string, _model: string): Promise<void> {
    const label = `[Scheduler] ${task.name}`
    touchActivity()
    await markPendingInjected(task.id, true)
    await this.pi.sendUserMessage?.(`${label}: ${renderPrompt(task.prompt)}`)
    if (task.notifyOnCompletion) {
      await sendWebhook(task, 'success', '')
    }
  }

  private async fireViaSubagent(task: Task, provider: string, model: string): Promise<void> {
    const { spawn } = await import('node:child_process')
    const timeout = (task.maxRunTime || 300) * 1000
    const label = `[Scheduler] ${task.name}`
    touchActivity()

    await new Promise<void>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const proc = spawn('pi', ['-p', renderPrompt(task.prompt)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
        cwd: process.cwd(),
      })
      let stderr = ''
      let stdout = ''
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.on('close', async (code) => {
        clearTimeout(timer)
        if (code === 0) {
          if (task.notifyOnCompletion) {
            await sendWebhook(task, 'success', stdout.slice(0, 1000))
          }
          resolve()
        } else {
          const err = new Error(stderr.trim() || `exit ${code}`) as Error & { exitCode?: number; outputLen?: number }
          err.exitCode = code
          err.outputLen = stdout.length
          reject(err)
        }
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
