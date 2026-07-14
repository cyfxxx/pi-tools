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
    this.timer = setInterval(() => this.tick(), 1000)
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
        this.fireTask(task)
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
    const label = `[Scheduler] ${task.name}`
    await this.pi.sendUserMessage?.(`${label}: ${task.prompt}`)
  }

  async checkMissedTasks(): Promise<{ name: string; result: string }[]> {
    const logD = logDir()
    const entries: { name: string; result: string }[] = []
    try {
      const { readdir, readFile } = await import('node:fs/promises')
      const files = await readdir(logD).catch(() => [] as string[])
      const unread = files
        .filter(f => f.endsWith('.log') && !f.includes('.read'))
        .sort()
        .slice(-10)
      for (const f of unread) {
        const content = await readFile(join(logD, f), 'utf-8').catch(() => '')
        const line = content.split('\n')[0] || f
        const [name, result] = line.split('|')
        entries.push({ name: name?.trim() || f, result: result?.trim() || 'unknown' })
        try {
          const { rename } = await import('node:fs/promises')
          await rename(join(logD, f), join(logD, f + '.read'))
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return entries
  }
}

function logDir(): string {
  const home = process.env.PI_HOME || join(process.env.HOME || '/root', '.pi')
  return join(home, 'logs', 'scheduler')
}

import { join } from 'node:path'
