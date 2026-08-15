import { readFile, writeFile, rename, mkdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Task, TaskStore, SchedulerSettings, ExecHistoryEntry } from './types.ts'
import { STORE_VERSION, DEFAULT_MAX_RUN_TIME, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS, HISTORY_LIMIT, TASKS_FILE } from './types.ts'

let lockPid: string | null = null

const AGENT_DIR = getAgentDir()

export function tasksPath(): string {
  return join(AGENT_DIR, 'scheduled-tasks.json')
}

export function lockPath(): string {
  return join(AGENT_DIR, 'scheduler.lock')
}

export function logDir(): string {
  return join(AGENT_DIR, '..', 'logs', 'scheduler')
}

function emptyStore(): TaskStore {
  return { version: STORE_VERSION, settings: {}, tasks: [] }
}

export async function acquireSessionLock(): Promise<boolean> {
  const lockF = lockPath()
  const myPid = String(process.pid)

  // 单次获取尝试。锁可能被 pi-cron.sh（离线调度）短暂写入后释放，
  // 或与之竞争——失败时由外层重试，避免把在线调度+看门狗静默关掉。
  const tryOnce = async (): Promise<boolean> => {
    // 检查是否存在陈旧锁（持有锁的进程已死）
    if (existsSync(lockF)) {
      try {
        const oldPid = (await readFile(lockF, 'utf-8')).trim()
        if (oldPid && oldPid !== myPid) {
          let alive = false
          if (process.platform === 'win32') {
            // Windows 无 /proc——tasklist 探进程存在性（便携版多实例互斥）
            const { execFile } = await import('node:child_process')
            alive = await new Promise<boolean>((res) => {
              execFile('tasklist', ['/FI', `PID eq ${oldPid}`], { windowsHide: true }, (err) => {
                res(!err) // tasklist 找到进程 → exit 0；找不到 → 非 0
              })
            })
          } else {
            try {
              await stat(`/proc/${oldPid}`)
              alive = true
            } catch {
              alive = false
            }
          }
          if (alive) {
            // 进程仍存活，锁被其他实例持有
            return false
          }
          // 进程已死，清理陈旧锁
          await unlink(lockF).catch(() => {})
        }
      } catch { /* 读锁文件失败，覆盖之 */ }
    }

    try {
      await writeFile(lockF + '.tmp', myPid, 'utf-8')
      await rename(lockF + '.tmp', lockF)
      await new Promise(r => setTimeout(r, 150))
      const content = await readFile(lockF, 'utf-8')
      return content.trim() === myPid
    } catch {
      return false
    }
  }

  // 重试：cron 每 60s 触发一次，竞争窗口极短；5 次 × 400ms 足够避开
  for (let i = 0; i < 5; i++) {
    if (await tryOnce()) {
      lockPid = myPid
      return true
    }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
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
    if (!Array.isArray(data.tasks)) data.tasks = []
    if (!data.settings) data.settings = {}
    if ((data.version ?? 1) < STORE_VERSION) migrateTasks(data)
    data.version = STORE_VERSION
    return data
  } catch {
    return emptyStore()
  }
}

function migrateTasks(data: TaskStore): void {
  for (const t of data.tasks) {
    if (!Array.isArray(t.history)) t.history = []
    if (!Array.isArray(t.tags)) t.tags = []
    if (typeof t.retries !== 'number') t.retries = 0
    if (typeof t.failCount !== 'number') t.failCount = 0
    if (typeof t.pendingInject !== 'boolean') t.pendingInject = false
    if (typeof t.maxRunTime !== 'number') t.maxRunTime = DEFAULT_MAX_RUN_TIME
    if (typeof t.notifyOnCompletion !== 'boolean') t.notifyOnCompletion = false
    if (typeof t.useSubagent !== 'boolean') t.useSubagent = false
    if (typeof t.runCount !== 'number') t.runCount = 0
    if (typeof t.lastResult !== 'string') t.lastResult = null
    if (typeof t.lastOutput !== 'string') t.lastOutput = ''
  }
}

// 任务存储 read-modify-write 互斥队列：tick 的 updateTaskAfterRun 与 /schedule delete/edit
// 并发时后写者不得用陈旧副本覆盖（否则已删除任务复活、更新丢失）。所有写路径串行化。
let storeWriteQueue: Promise<unknown> = Promise.resolve()
export function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeWriteQueue.then(fn, fn)
  storeWriteQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
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

/**
 * A1: 指数退避 + 抖动重试延迟（golem RetryUtils 的轻量移植）。
 * delay = min(max, base * 2^(failCount-1)) ± jitter(±50%)，下限 base/2。
 * 连续瞬时故障（provider_down/超时/5xx）用递增延迟避免自撞；抖动防共振。
 */
export function retryDelayMs(failCount: number): number {
  const base = RETRY_BASE_DELAY_MS
  const max = RETRY_MAX_DELAY_MS
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, failCount - 1)))
  const jitter = exp * 0.5 * (Math.random() * 2 - 1)
  return Math.max(base / 2, Math.round(exp + jitter))
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
  tags?: string[]
  retries?: number
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
    history: [],
    tags: params.tags ?? [],
    retries: Math.max(0, params.retries ?? 0),
    failCount: 0,
    pendingInject: false,
    recoveryCount: 0,
    createdAt: isoNow(),
    updatedAt: isoNow(),
  }
  task.nextRun = computeNextRun(task)
  if (task.nextRun === null) {
    throw new Error(
      `无效调度表达式: "${params.schedule}"（类型 ${params.type}）。` +
      `interval 示例 "5m"/"1h"，cron 示例 "0 9 * * 1-5"，once 示例 "+30m" 或 ISO 时间`
    )
  }
  return task
}

export async function addTask(params: Parameters<typeof createTask>[0]): Promise<Task> {
  return withStoreLock(async () => {
  const store = await readTasks()
  if (store.tasks.some(t => t.name === params.name)) {
    throw new Error(`已存在同名任务: "${params.name}"，请更换名称`)
  }
  const task = createTask(params)
  store.tasks.push(task)
  await writeTasks(store)
  return task
  })
}

export async function updateTask(
  idOrName: string,
  updates: Partial<Pick<Task, 'enabled' | 'prompt' | 'schedule' | 'type' | 'useSubagent' | 'notifyOnCompletion' | 'maxRunTime' | 'name' | 'tags' | 'retries' | 'recoveryCount'>>
): Promise<Task | null> {
  return withStoreLock(async () => {
  const store = await readTasks()
  const task = store.tasks.find(t => t.id === idOrName || t.name === idOrName)
  if (!task) return null
  let needsRecalc = false
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      if (k === 'tags' && !Array.isArray(v)) continue
      ;(task as any)[k] = v
      if (k === 'schedule' || k === 'type') needsRecalc = true
    }
  }
  if (needsRecalc) {
    task.nextRun = computeNextRun(task)
    if (task.nextRun === null) {
      throw new Error(
        `无效调度表达式: "${task.schedule}"（类型 ${task.type}）。` +
        `interval 示例 "5m"/"1h"，cron 示例 "0 9 * * 1-5"，once 示例 "+30m" 或 ISO 时间`
      )
    }
  }
  task.updatedAt = isoNow()
  await writeTasks(store)
  return task
  })
}

export async function deleteTask(idOrName: string): Promise<boolean> {
  return withStoreLock(async () => {
  const store = await readTasks()
  const idx = store.tasks.findIndex(t => t.id === idOrName || t.name === idOrName)
  if (idx === -1) return false
  store.tasks.splice(idx, 1)
  await writeTasks(store)
  return true
  })
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
  output: string,
  durationMs?: number
): Promise<void> {
  return withStoreLock(async () => {
  const store = await readTasks()
  const idx = store.tasks.findIndex(t => t.id === id)
  if (idx === -1) return
  const task = store.tasks[idx]

  const historyEntry: ExecHistoryEntry = {
    time: isoNow(),
    result,
    output: output.slice(0, 1000),
    durationMs,
  }
  task.history.push(historyEntry)
  if (task.history.length > HISTORY_LIMIT) task.history = task.history.slice(-HISTORY_LIMIT)

  task.lastRun = isoNow()
  task.lastResult = result
  task.lastOutput = output.slice(0, 1000)
  task.updatedAt = isoNow()

  if (result === 'success') {
    task.failCount = 0
    task.runCount++
    // once 任务完成后自动清理
    if (task.type === 'once') {
      store.tasks.splice(idx, 1)
      await writeTasks(store)
      return
    }
    task.nextRun = computeNextRun(task)
  } else {
    task.failCount++
    if (task.retries > 0 && task.failCount <= task.retries) {
      // 失败重试：指数退避 + 抖动（A1，借鉴 golem RetryUtils）——
      // 连续瞬时故障（provider_down/超时）用递增延迟避免自撞，抖动防共振
      task.nextRun = addMs(isoNow(), retryDelayMs(task.failCount))
    } else {
      // once 任务重试耗尽：与成功分支一致直接移除，避免 nextRun=null 永久滞留列表
      if (task.type === 'once') {
        store.tasks.splice(idx, 1)
        await writeTasks(store)
        return
      }
      task.runCount++
      task.nextRun = computeNextRun(task)
    }
  }
  await writeTasks(store)
  })
}

export async function getSettings(): Promise<SchedulerSettings> {
  const store = await readTasks()
  return store.settings
}

export async function setSettings(updates: Partial<SchedulerSettings>): Promise<SchedulerSettings> {
  return withStoreLock(async () => {
  const store = await readTasks()
  store.settings = { ...store.settings, ...updates }
  await writeTasks(store)
  return store.settings
  })
}

export function renderPrompt(prompt: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const vars: Record<string, string> = {
    '{{date}}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    '{{time}}': `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    '{{datetime}}': now.toISOString(),
    '{{cwd}}': process.cwd(),
  }
  let out = prompt
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v)
  return out
}

export async function previewCron(expr: string, count = 5): Promise<string[]> {
  if (!CronClass) throw new Error('croner 不可用')
  const out: string[] = []
  let startAt: Date | undefined
  for (let i = 0; i < count; i++) {
    let cron: any
    try {
      cron = new CronClass(expr, { legacyMode: false, startAt })
    } catch {
      throw new Error(`无效 cron 表达式: "${expr}"`)
    }
    const next = cron.nextRun()
    if (!next) break
    out.push(next.toISOString())
    startAt = new Date(next.getTime() + 1)
  }
  if (out.length === 0) throw new Error(`无效 cron 表达式: "${expr}"（无未来触发时间）`)
  return out
}

export async function sendWebhook(task: Pick<Task, 'name' | 'type' | 'schedule'>, result: string, output: string): Promise<void> {
  let url = process.env.PI_SCHEDULER_WEBHOOK || ''
  if (!url) {
    const settings = await getSettings()
    url = settings.webhookUrl || ''
  }
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: task.name,
        type: task.type,
        schedule: task.schedule,
        result,
        time: isoNow(),
        output: (output || '').slice(0, 1000),
      }),
      signal: AbortSignal.timeout(10000),
    })
  } catch { /* 通知失败不影响调度 */ }
}

export async function exportTasks(): Promise<string> {
  const store = await readTasks()
  const outPath = join(AGENT_DIR, `scheduler-export-${Date.now()}.json`)
  await writeFile(outPath, JSON.stringify({ version: STORE_VERSION, exportedAt: isoNow(), tasks: store.tasks }, null, 2), 'utf-8')
  return outPath
}

export async function importTasks(filePath: string): Promise<{ imported: number; skipped: string[] }> {
  const raw = await readFile(filePath, 'utf-8')
  const data = JSON.parse(raw) as { tasks?: unknown[] }
  if (!Array.isArray(data.tasks)) throw new Error(`导入文件无 tasks 数组: ${filePath}`)
  const store = await readTasks()
  const existing = new Set(store.tasks.map(t => t.name))
  const skipped: string[] = []
  let imported = 0
  for (const rawTask of data.tasks as Record<string, unknown>[]) {
    if (!rawTask || typeof rawTask !== 'object') continue
    const name = String(rawTask.name ?? '')
    const type = rawTask.type as Task['type']
    const schedule = String(rawTask.schedule ?? '')
    const prompt = String(rawTask.prompt ?? '')
    if (!name || !type || !schedule || !prompt) { skipped.push(name || '<未命名>'); continue }
    if (existing.has(name)) { skipped.push(name); continue }
    try {
      const task = createTask({
        name,
        type,
        schedule,
        prompt,
        enabled: rawTask.enabled as boolean | undefined,
        useSubagent: rawTask.useSubagent as boolean | undefined,
        notifyOnCompletion: rawTask.notifyOnCompletion as boolean | undefined,
        maxRunTime: rawTask.maxRunTime as number | undefined,
        tags: Array.isArray(rawTask.tags) ? rawTask.tags as string[] : undefined,
        retries: rawTask.retries as number | undefined,
      })
      store.tasks.push(task)
      imported++
      existing.add(name)
    } catch {
      skipped.push(name)
    }
  }
  if (imported > 0) await writeTasks(store)
  return { imported, skipped }
}
