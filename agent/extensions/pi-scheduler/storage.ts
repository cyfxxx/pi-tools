import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Task, TaskStore, SchedulerSettings } from './types.ts'
import { STORE_VERSION, DEFAULT_MAX_RUN_TIME } from './types.ts'

function agentDir(): string {
  return process.env.PI_HOME
    ? join(process.env.PI_HOME, 'agent')
    : join(process.env.HOME || '/root', '.pi', 'agent')
}

let lockPid: string | null = null

export function tasksPath(): string {
  return join(agentDir(), 'scheduled-tasks.json')
}

export function lockPath(): string {
  return join(agentDir(), 'scheduler.lock')
}

export function logDir(): string {
  return join(agentDir(), '..', 'logs', 'scheduler')
}

function emptyStore(): TaskStore {
  return { version: STORE_VERSION, settings: {}, tasks: [] }
}

export async function acquireSessionLock(): Promise<boolean> {
  const lockF = lockPath()
  const myPid = String(process.pid)
  try {
    await writeFile(lockF + '.tmp', myPid, 'utf-8')
    await rename(lockF + '.tmp', lockF)
    await new Promise(r => setTimeout(r, 150))
    const content = await readFile(lockF, 'utf-8')
    const held = content.trim() === myPid
    if (held) lockPid = myPid
    return held
  } catch {
    return false
  }
}

export async function releaseSessionLock(): Promise<void> {
  if (!lockPid) return
  try {
    await unlink(lockPath())
  } catch { /* ignore */ }
  lockPid = null
}

export async function readTasks(): Promise<TaskStore> {
  const p = tasksPath()
  try {
    const raw = await readFile(p, 'utf-8')
    const data = JSON.parse(raw) as TaskStore
    if (!data.tasks) data.tasks = []
    if (!data.settings) data.settings = {}
    return data
  } catch {
    return emptyStore()
  }
}

export async function writeTasks(store: TaskStore): Promise<void> {
  const p = tasksPath()
  const tmp = p + '.tmp.' + process.pid
  await mkdir(dirname(p), { recursive: true })
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8')
  await rename(tmp, p)
}

function parseInterval(s: string): number | null {
  const m = s.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  switch (m[2].toLowerCase()[0]) {
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 3600 * 1000
    case 'd': return n * 86400 * 1000
    default: return null
  }
}

export function parseRelativeTime(s: string): number | null {
  const m = s.match(/^\+(\d+)\s*(s|m|h|d|min|hr)?$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = (m[2] || 'm').toLowerCase()[0]
  switch (unit) {
    case 's': return n * 1000
    case 'm': return n * 60 * 1000
    case 'h': return n * 3600 * 1000
    case 'd': return n * 86400 * 1000
    default: return null
  }
}

export function formatInterval(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`
  return `${Math.round(ms / 86400000)}d`
}

export function parseTimeToMs(timeStr: string): number | null {
  const rel = parseRelativeTime(timeStr)
  if (rel !== null) return rel

  const int = parseInterval(timeStr)
  if (int !== null) return int

  return null
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function addMs(date: string, ms: number): string {
  return new Date(new Date(date).getTime() + ms).toISOString()
}

export function isDue(task: Task): boolean {
  if (!task.enabled || !task.nextRun) return false
  return new Date(task.nextRun).getTime() <= Date.now()
}

export function parseIntervalToMs(s: string): number | null {
  return parseInterval(s) ?? parseRelativeTime(s) ?? null
}

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let CronClass: any = null
try {
  const mod = require('croner')
  CronClass = mod.Cron || mod.default || mod
} catch { /* croner not available */ }

export function computeNextRun(task: Task): string | null {
  const now = new Date()

  if (task.type === 'once') {
    if (task.lastRun) return null
    const rel = parseRelativeTime(task.schedule)
    if (rel !== null) return addMs(isoNow(), rel)
    try {
      const d = new Date(task.schedule)
      if (!isNaN(d.getTime())) return d.toISOString()
    } catch { /* ignore */ }
    return null
  }

  if (task.type === 'interval') {
    const ms = parseIntervalToMs(task.schedule)
    if (ms === null) return null
    const from = task.lastRun ? new Date(task.lastRun) : now
    return new Date(from.getTime() + ms).toISOString()
  }

  if (task.type === 'cron') {
    if (CronClass) {
      try {
        const cron = new CronClass(task.schedule, { legacyMode: false })
        const next = cron.nextRun()
        return next ? next.toISOString() : null
      } catch { return null }
    }
    return null
  }

  return null
}

export function createTask(params: {
  name: string
  type: Task['type']
  schedule: string
  prompt: string
  enabled?: boolean
  useSubagent?: boolean
  notifyOnCompletion?: boolean
  maxRunTime?: number
}): Task {
  const task: Task = {
    id: randomUUID(),
    name: params.name,
    type: params.type,
    schedule: params.schedule,
    prompt: params.prompt,
    enabled: params.enabled ?? true,
    lastRun: null,
    lastResult: null,
    lastOutput: '',
    nextRun: null,
    useSubagent: params.useSubagent ?? false,
    notifyOnCompletion: params.notifyOnCompletion ?? false,
    maxRunTime: params.maxRunTime ?? DEFAULT_MAX_RUN_TIME,
    runCount: 0,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  }
  task.nextRun = computeNextRun(task)
  return task
}

export async function addTask(params: Parameters<typeof createTask>[0]): Promise<Task> {
  const store = await readTasks()
  const task = createTask(params)
  store.tasks.push(task)
  await writeTasks(store)
  return task
}

export async function updateTask(
  idOrName: string,
  updates: Partial<Pick<Task, 'enabled' | 'prompt' | 'schedule' | 'useSubagent' | 'notifyOnCompletion' | 'maxRunTime' | 'name'>>
): Promise<Task | null> {
  const store = await readTasks()
  const task = store.tasks.find(t => t.id === idOrName || t.name === idOrName)
  if (!task) return null
  let needsRecalc = false
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      ;(task as any)[k] = v
      if (k === 'schedule' || k === 'type') needsRecalc = true
    }
  }
  if (needsRecalc) task.nextRun = computeNextRun(task)
  task.updatedAt = isoNow()
  await writeTasks(store)
  return task
}

export async function deleteTask(idOrName: string): Promise<boolean> {
  const store = await readTasks()
  const idx = store.tasks.findIndex(t => t.id === idOrName || t.name === idOrName)
  if (idx === -1) return false
  store.tasks.splice(idx, 1)
  await writeTasks(store)
  return true
}

export async function listTasks(): Promise<Task[]> {
  const store = await readTasks()
  return store.tasks.sort((a, b) => {
    if (!a.nextRun) return 1
    if (!b.nextRun) return -1
    return a.nextRun.localeCompare(b.nextRun)
  })
}

export async function updateTaskAfterRun(
  id: string,
  result: 'success' | 'failed',
  output: string
): Promise<void> {
  const store = await readTasks()
  const task = store.tasks.find(t => t.id === id)
  if (!task) return
  task.lastRun = isoNow()
  task.lastResult = result
  task.lastOutput = output.slice(0, 1000)
  task.runCount++
  task.nextRun = computeNextRun(task)
  task.updatedAt = isoNow()
  await writeTasks(store)
}
