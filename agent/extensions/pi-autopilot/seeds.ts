/**
 * 种子任务对账（2026-08-27 用户需求）：跨设备每日任务自动注册
 *
 * agent/scheduled-seeds.json（git 入库共享）定义各设备通用任务种子；
 * pi-autopilot 启动与 tick 时对账：本地 scheduled-tasks.json 缺失同名任务
 * 则自动注册（幂等，已存在跳过，不覆盖本地已有任务；用户删过的不复活——只补缺失）。
 * 其他设备 git pull 后无需手动操作，30s tick 即自动加入。
 * 种子文件修改 push 后，各设备 pull 即传播新任务；启用/禁用仍由本地 /schedule 管理。
 */
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { readTasks, addTask } from './storage.ts'
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

/** 对账：本地缺失的种子任务自动注册；返回新增数量（幂等）。existing 可传入已读任务名避免重复 IO */
export async function syncSeedTasks(existing?: Set<string>): Promise<number> {
  const seeds = await loadSeeds()
  if (seeds.length === 0) return 0
  const names = existing ?? new Set((await readTasks()).tasks.map((t: Task) => t.name))
  let added = 0
  for (const s of seeds) {
    if (names.has(s.name)) continue
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
  }
  return added
}