/**
 * 种子任务对账（2026-08-27 用户需求）：跨设备每日任务自动注册
 *
 * agent/scheduled-seeds.json（git 入库共享）定义各设备通用任务种子；
 * pi-autopilot 启动与 tick 时对账：本地 scheduled-tasks.json 缺失同名任务
 * 则自动注册（幂等，已存在跳过，不覆盖本地已有任务；用户删过的不复活——只补缺失）。
 * 其他设备 git pull 后无需手动操作，30s tick 即自动加入。
 * 种子文件修改 push 后，各设备 pull 即传播新任务；启用/禁用仍由本地 /schedule 管理。
 *
 * 漂移提醒（2026-08-29 用户需求）：对账"不覆盖"导致 seeds 更新后同名本地任务静默滞留旧定义。
 * 现对同名任务比对 type/schedule/prompt：有差异即记入返回值 drifted，并由调用方提醒
 * （session_start console 一行）；漂移集合签名变化时追加 logs/scheduler/seed-drift.log
 * （tick 每 30s 跑一次，签名去重防刷屏；漂移消除写"已消除"闭合行）。
 * 每日硬层告警由 scripts/daily-health.mjs 独立比对（守门防篡改：不依赖本扩展写的状态）。
 */
import { stat, readFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { readTasks, addTask, logDir } from './storage.ts'
import type { Task, TaskType } from './types.ts'

const SEEDS_FILE = 'scheduled-seeds.json'

export interface SeedTaskDef {
  name: string
  type: TaskType
  schedule: string
  prompt: string
  useSubagent?: boolean
  notifyMain?: boolean
  waitForUserOnLocal?: boolean
  maxRunTime?: number
  retries?: number
  tags?: string[]
}

let cachedSeeds: SeedTaskDef[] | null = null
let cachedMtimeMs = 0

const isSeedLike = (s: unknown): s is SeedTaskDef => {
  const v = s as SeedTaskDef
  return !!v && typeof v.name === 'string' && !!v.name
    && (v.type === 'interval' || v.type === 'cron' || v.type === 'once')
    && typeof v.schedule === 'string' && !!v.schedule
    && typeof v.prompt === 'string' && !!v.prompt
}

/** 读取种子任务定义（mtime 变化才重读；文件缺失/损坏返回 []） */
export async function loadSeeds(): Promise<SeedTaskDef[]> {
  try {
    const p = join(getAgentDir(), SEEDS_FILE)
    const st = await stat(p)
    if (cachedSeeds && st.mtimeMs === cachedMtimeMs) return cachedSeeds
    const raw = JSON.parse(await readFile(p, 'utf8')) as { tasks?: unknown[] }
    const seeds = (Array.isArray(raw?.tasks) ? raw.tasks : []).filter(isSeedLike)
    cachedSeeds = seeds
    cachedMtimeMs = st.mtimeMs
    return seeds
  } catch {
    return cachedSeeds ?? []
  }
}

/** 测试重置缓存 */
export function __resetSeedCache(): void {
  cachedSeeds = null
  cachedMtimeMs = 0
}

/** 测试重置漂移签名状态（recordDriftLog 跨用例残留） */
export function __resetDriftSig(): void {
  lastDriftSig = null
}

/** 对账结果：added=本次新注册的缺失任务数；drifted=与种子定义不一致的本地任务描述（不覆盖，仅提醒） */
export interface SeedSyncResult {
  added: number
  drifted: string[]
}

/** 纯函数：比较本地同名任务与种子定义，返回差异摘要（如 "schedule 0 9 * * *≠0 8 * * *+prompt"），一致返回 null */
export function diffSeedTask(local: Pick<Task, 'type' | 'schedule' | 'prompt'>, s: SeedTaskDef): string | null {
  const diffs: string[] = []
  if (local.type !== s.type) diffs.push(`type ${local.type}≠${s.type}`)
  if (local.schedule !== s.schedule) diffs.push(`schedule ${local.schedule}≠${s.schedule}`)
  if (local.prompt !== s.prompt) diffs.push('prompt')
  return diffs.length ? diffs.join('+') : null
}

// 漂移签名去重：tick 每 30s 对账一次，漂移集合不变时不重复写日志（防刷屏）
let lastDriftSig: string | null = null

function recordDriftLog(drifted: string[]): void {
  const sig = drifted.join('§')
  const prev = lastDriftSig
  lastDriftSig = sig
  try {
    if (drifted.length && sig !== prev) {
      mkdirSync(logDir(), { recursive: true })
      appendFileSync(join(logDir(), 'seed-drift.log'), `[${new Date().toISOString()}] 漂移: ${drifted.join('；')}\n`)
    } else if (!drifted.length && prev) {
      mkdirSync(logDir(), { recursive: true })
      appendFileSync(join(logDir(), 'seed-drift.log'), `[${new Date().toISOString()}] 漂移已消除（本地任务与 seeds 重新一致）\n`)
    }
  } catch { /* 日志失败不阻塞对账 */ }
}

/**
 * 对账：本地缺失的种子任务自动注册（幂等，不覆盖本地已有任务）；
 * 同名任务与 seeds 定义有差异时记入 drifted 并写漂移日志（签名去重）。
 * existing 传 Task[]（index/scheduler 均已有对象）做完整漂移比对；
 * 传 Set<string> 仅补缺失（无任务对象，漂移检测退化）；不传则内部读取全量任务。
 */
export async function syncSeedTasks(existing?: Set<string> | Task[]): Promise<SeedSyncResult> {
  const seeds = await loadSeeds()
  if (seeds.length === 0) return { added: 0, drifted: [] }
  let byName: Map<string, Task>
  let nameSet: Set<string>
  if (Array.isArray(existing)) {
    byName = new Map(existing.map(t => [t.name, t]))
    nameSet = new Set(byName.keys())
  } else {
    const store = existing ? null : await readTasks()
    const all = (store?.tasks ?? []) as Task[]
    byName = new Map(all.map(t => [t.name, t]))
    nameSet = existing ?? new Set(byName.keys())
  }
  let added = 0
  const drifted: string[] = []
  for (const s of seeds) {
    const local = byName.get(s.name)
    if (!local) {
      if (nameSet.has(s.name)) continue // Set 分支：名字已存在但无对象可比对
      try {
        await addTask({
          name: s.name,
          type: s.type,
          schedule: s.schedule,
          prompt: s.prompt,
          useSubagent: s.useSubagent,
          notifyMain: s.notifyMain,
          waitForUserOnLocal: s.waitForUserOnLocal,
          maxRunTime: s.maxRunTime,
          retries: s.retries,
          tags: s.tags,
        })
        added++
      } catch { /* 单条失败（如表达式非法）不阻塞其余 */ }
      continue
    }
    const d = diffSeedTask(local, s)
    if (d) drifted.push(`${s.name}(${d})`)
  }
  recordDriftLog(drifted)
  return { added, drifted }
}