import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { listTasks, isDue, updateTaskAfterRun, readTasks, writeTasks } from './storage.ts'
import type { Task } from './types.ts'

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

  private async tick(): Promise<void> {
    try {
      const tasks = await listTasks()
      const due = tasks.filter(t => isDue(t) && !this.firing.has(t.id))
      for (const task of due) {
        if (this.firing.has(task.id)) continue
        await this.fireTask(task)
      }
    } catch { /* suppress tick errors */ }
  }

  private async fireTask(task: Task): Promise<void> {
    this.firing.add(task.id)
    try {
      if (task.useSubagent) {
        await this.fireViaSubagent(task)
      } else {
        await this.fireViaMessage(task)
      }
      await updateTaskAfterRun(task.id, 'success', '')
    } catch (err) {
      await updateTaskAfterRun(task.id, 'failed', String(err))
    } finally {
      this.firing.delete(task.id)
    }
  }

  private async fireViaMessage(task: Task): Promise<void> {
    const label = `[Scheduler] ${task.name}`
    await this.pi.sendUserMessage?.(`${label}: ${task.prompt}`)
  }

  private async fireViaSubagent(task: Task): Promise<void> {
    const { spawn } = await import('node:child_process')
    const timeout = (task.maxRunTime || 300) * 1000
    const label = `[Scheduler] ${task.name}`

    await new Promise<void>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const proc = spawn('pi', ['-p', task.prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
      })
      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(stderr.trim() || `exit ${code}`))
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
