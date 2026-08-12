import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { readTasks, writeTasks } from './storage.ts'
import type { Task } from './types.ts'
import { CRASH_FILE } from './types.ts'

const AGENT_DIR = getAgentDir()

// A2: 崩溃恢复重注入次数上限（借鉴 swarmclaw orphan-recovery）
export const MAX_RECOVERY_ATTEMPTS = 3

// 标记任务已注入（会话中断时用于恢复）
export async function markPendingInjected(id: string, pending: boolean = true): Promise<void> {
  const store = await readTasks()
  const task = store.tasks.find(t => t.id === id)
  if (!task) return
  task.pendingInject = pending
  task.updatedAt = new Date().toISOString()
  await writeTasks(store)
}

export async function clearPending(id: string): Promise<void> {
  await markPendingInjected(id, false)
}

/** 清除所有任务的 pendingInject 标记（主会话空闲=注入任务已完成）。 */
export async function clearAllPending(): Promise<void> {
  const store = await readTasks()
  let changed = false
  for (const task of store.tasks) {
    if (task.pendingInject) {
      task.pendingInject = false
      task.updatedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) await writeTasks(store)
}

// 收集待恢复注入的任务
export async function collectPendingTasks(): Promise<Task[]> {
  const store = await readTasks()
  return store.tasks.filter(t => t.enabled && t.pendingInject)
}

// 上次会话是否异常结束（wrapper 崩溃计数 > 0）
export async function wasAbnormalShutdown(): Promise<boolean> {
  try {
    const raw = await readFile(join(AGENT_DIR, CRASH_FILE), 'utf-8')
    const data = JSON.parse(raw) as { count?: number }
    return (data.count ?? 0) > 0
  } catch {
    return false
  }
}
