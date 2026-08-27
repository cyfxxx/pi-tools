import { readFile, writeFile, rename, mkdir, unlink, stat, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { Task, TaskStore, SchedulerSettings, ExecHistoryEntry } from './types.ts'
import { appendTaskResult } from './results.ts'
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

/** tasklist 输出是否包含指定 PID（按空白 token 精确匹配，避免子串误命中）。
 * 无匹配时 tasklist 打印 "INFO: No tasks are running..." 且 exit 0——不能用错误码判断。 */
export function isPidInTasklistOutput(stdout: string, pid: string | number): boolean {
  return stdout.split(/\s+/).includes(String(pid))
}

export async function acquireSessionLock(): Promise<boolean> {
  const lockF = lockPath()
  const myPid = String(process.pid)
  // 审计 LOW：锁内容 PID:时间戳——进程活着但调度异常停摆时锁被永久占用；
  // PID 复用（旧进程死后新进程恰巧同 PID）会误判 alive。时间戳超 24h 视为
  // 过期租约（无论 PID 是否活着），允许覆盖。
  const LOCK_TTL_MS = 24 * 3600 * 1000

  // 单次获取尝试。锁可能被 pi-cron.sh（离线调度）短暂写入后释放，
  // 或与之竞争——失败时由外层重试，避免把在线调度+看门狗静默关掉。
  const tryOnce = async (): Promise<boolean> => {
    // 检查是否存在陈旧锁（持有锁的进程已死 / 租约过期）
    if (existsSync(lockF)) {
      try {
        const raw = (await readFile(lockF, 'utf-8')).trim()
        const oldPid = raw.split(':')[0] ?? raw
        const oldTs = Number(raw.split(':')[1] ?? 0)
        const staleByAge = oldTs > 0 && Date.now() - oldTs > LOCK_TTL_MS
        if (oldPid && oldPid !== myPid && !staleByAge) {
          let alive = false
          if (process.platform === 'win32') {
            // Windows 无 /proc——tasklist 探进程存在性（便携版多实例互斥）。
            // 审计 MEDIUM 修复：tasklist 无匹配时打印 "INFO: No tasks..." 仍 exit 0，
            // 不能用 !err 判存活——必须解析 stdout 是否含该 PID token。
            const { execFile } = await import('node:child_process')
            alive = await new Promise<boolean>((res) => {
              execFile('tasklist', ['/FI', `PID eq ${oldPid}`], { windowsHide: true }, (err, stdout) => {
                res(!err && isPidInTasklistOutput(String(stdout ?? ''), oldPid))
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
        } else {
          // 审计 HIGH 修复（2026-08-25）：租约过期或同 PID 残留锁也必须先清理——
          // 原逻辑仅「其他 PID 且未过期」才走存活检测+unlink，过期/同 PID 锁直接落到
          // 下方 O_EXCL 创建必 EEXIST，5 次重试全败 → 调度永久停摆（上方注释宣称的
          // 「允许覆盖」与实现相反）。同 PID 说明本进程此前获取后未正常释放，重写刷新租约即可。
          await unlink(lockF).catch(() => {})
        }
      } catch { /* 读锁文件失败，覆盖之 */ }
    }

    try {
      // 审计 MEDIUM 修复（2026-08-18）：rename 覆盖式写锁非原子——实例 B 的 rename
      // 落在实例 A 的 150ms 回读校验之后时，双方都验证通过（双调度器并发跑同一任务、
      // 重复扣预算）。改 O_EXCL 原子创建：创建成功 = 唯一持有者，失败 = 他人持有，
      // 无需回读校验，竞争窗口彻底消除。
      await writeFile(lockF, `${myPid}:${Date.now()}`, { encoding: 'utf-8', flag: 'wx' })
      return true
    } catch {
      // EEXIST：竞态中他人刚创建——由外层重试（下一轮先判陈旧再尝试）
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
    // 审计 MEDIUM 修复：无条件 unlink 可能删掉他人刚获取的锁（本进程 lockPid 过期后
    // 另一实例已持锁）——先校验锁文件持有者是自己再删
    const raw = await readFile(lockPath(), 'utf-8')
    if (raw.trim().split(':')[0] === String(lockPid)) {
      await unlink(lockPath())
    }
  } catch {
    /* 锁文件不存在（他人已释放/被清理） */
  }
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
  } catch (e: unknown) {
    // 审计 MEDIUM 修复：损坏不再静默吞掉——文件不存在属首次运行（静默），
    // 解析失败则留档 .corrupt-<ts> 再返回空，避免下一次任意写用空列表覆盖磁盘后证据消失。
    const isNotFound = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    if (!isNotFound) {
      try {
        const raw = await readFile(p, 'utf-8').catch(() => null)
        if (raw !== null) {
          const backup = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
          await writeFile(backup, raw, 'utf-8')
          console.error(`[pi-autopilot] tasks.json 解析失败，已留档 ${backup}：`, e)
          // 审计 LOW：corrupt 留档上限 10 份，超出删最旧防无限堆积
          try {
            const dir = dirname(p)
            const base = basename(p)
            const olds = (await readdir(dir))
              .filter(f => f.startsWith(`${base}.corrupt-`))
              .sort()
            for (const f of olds.slice(0, Math.max(0, olds.length - 10))) {
              await rm(join(dir, f), { force: true })
            }
          } catch { /* 清理失败不阻塞 */ }
        }
      } catch { /* 留档失败不阻塞 */ }
    }
    return emptyStore()
  }
}

function migrateTasks(data: TaskStore): void {
  for (const t of data.tasks) {
    if (!Array.isArray(t.history)) t.history = []
    if (!Array.isArray(t.tags)) t.tags = []
    if (typeof t.retries !== 'number') t.retries = 0
    if (typeof t.failCount !== 'number') t.failCount = 0
    if (typeof t.failoverCount !== 'number') t.failoverCount = 0
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
  notifyMain?: boolean
  waitForUserOnLocal?: boolean
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
    notifyMain: params.notifyMain ?? false,
    waitForUserOnLocal: params.waitForUserOnLocal ?? false,
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
  updates: Partial<Pick<Task, 'enabled' | 'prompt' | 'schedule' | 'type' | 'useSubagent' | 'notifyOnCompletion' | 'notifyMain' | 'waitForUserOnLocal' | 'maxRunTime' | 'name' | 'tags' | 'retries' | 'recoveryCount' | 'failCount' | 'failoverCount'>>
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
  // 软删墓碑过滤：deleted 任务对调度器/列表不可见（防陈旧副本写回复活，2026-08-25）
  return store.tasks.filter(t => !t.deleted).sort((a, b) => {
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

  // 结果跨设备同步（2026-08-27）：append-only 每设备独立文件入库共享，
  // 其他设备 pull 后可见全部每日任务执行结果；写入失败静默不阻塞记账
  appendTaskResult({ taskId: id, taskName: task.name, result, output, durationMs })

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
    task.failoverCount = 0
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
  // 审计 MEDIUM 修复（2026-08-25）：读改写全程持 store 写互斥锁——与 tick 的
  // updateTaskAfterRun 并发时旧快照覆盖会丢更新（addTask/updateTask/deleteTask 均已持锁）
  return withStoreLock(async () => {
  const store = await readTasks()
  const existing = new Set(store.tasks.map(t => t.name))
  const skipped: string[] = []
  let imported = 0
  for (const rawTask of data.tasks as Record<string, unknown>[]) {
    if (!rawTask || typeof rawTask !== 'object') continue
    // 软删墓碑防御：陈旧导出里的 deleted 任务不导入（防复活）
    if ((rawTask as { deleted?: unknown }).deleted === true) { skipped.push(String((rawTask as { name?: unknown }).name ?? '<未命名>')); continue }
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
  })
}
