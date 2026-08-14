import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { TelemetryEntry, TelemetryStore, ErrorClass } from './types.ts'
import { TELEMETRY_FILE, TELEMETRY_LIMIT } from './types.ts'
import { readModels } from './config.ts'

const AGENT_DIR = getAgentDir()

export function telemetryPath(): string {
  return join(AGENT_DIR, TELEMETRY_FILE)
}

export async function readTelemetry(): Promise<TelemetryEntry[]> {
  try {
    const raw = await readFile(telemetryPath(), 'utf-8')
    const data = JSON.parse(raw) as TelemetryStore
    if (!Array.isArray(data.runs)) return []
    return data.runs
  } catch {
    return []
  }
}

export async function appendRun(entry: TelemetryEntry): Promise<void> {
  const runs = await readTelemetry()
  runs.push(entry)
  const trimmed = runs.length > TELEMETRY_LIMIT ? runs.slice(-TELEMETRY_LIMIT) : runs
  const p = telemetryPath()
  // pid 后缀：与 storage.ts 一致，防并发 appendRun（tick 与命令并发）互踩 tmp 文件
  // 致 rename ENOENT 把正常执行误记为 failed
  const tmp = p + '.tmp.' + process.pid
  await mkdir(dirname(p), { recursive: true })
  await writeFile(tmp, JSON.stringify({ runs: trimmed }, null, 2), 'utf-8')
  await (await import('node:fs/promises')).rename(tmp, p)
}

export interface ModelStats {
  provider: string
  model: string
  runs: number
  failures: number
  successRate: number
  avgDurationMs: number
  totalCost: number
}

export interface TaskStats {
  taskId: string
  taskName: string
  runs: number
  failures: number
  successRate: number
}

export function statsByModel(runs: TelemetryEntry[]): ModelStats[] {
  const map = new Map<string, TelemetryEntry[]>()
  for (const r of runs) {
    const key = `${r.provider}/${r.model}`
    const arr = map.get(key) || []
    arr.push(r)
    map.set(key, arr)
  }
  const out: ModelStats[] = []
  for (const [key, arr] of map) {
    const [provider, model] = key.split('/')
    const failures = arr.filter(r => r.result === 'failed').length
    out.push({
      provider,
      model,
      runs: arr.length,
      failures,
      successRate: arr.length ? (arr.length - failures) / arr.length : 0,
      avgDurationMs: arr.length ? arr.reduce((s, r) => s + r.durationMs, 0) / arr.length : 0,
      totalCost: arr.reduce((s, r) => s + (r.estCost || 0), 0),
    })
  }
  return out.sort((a, b) => b.successRate - a.successRate)
}

export function statsByTask(runs: TelemetryEntry[]): TaskStats[] {
  const map = new Map<string, TelemetryEntry[]>()
  for (const r of runs) {
    const arr = map.get(r.taskId) || []
    arr.push(r)
    map.set(r.taskId, arr)
  }
  const out: TaskStats[] = []
  for (const [taskId, arr] of map) {
    const failures = arr.filter(r => r.result === 'failed').length
    out.push({
      taskId,
      taskName: arr[0]?.taskName || taskId,
      runs: arr.length,
      failures,
      successRate: arr.length ? (arr.length - failures) / arr.length : 0,
    })
  }
  return out.sort((a, b) => b.runs - a.runs)
}

export function todayRuns(runs: TelemetryEntry[]): number {
  const today = new Date().toISOString().slice(0, 10)
  return runs.filter(r => r.ts.slice(0, 10) === today).length
}

export function todayCost(runs: TelemetryEntry[]): number {
  const today = new Date().toISOString().slice(0, 10)
  return runs.filter(r => r.ts.slice(0, 10) === today).reduce((s, r) => s + (r.estCost || 0), 0)
}

// 估算成本：读 models.json 可选 pricePer1kIn/pricePer1kOut 字段
export function estimateCost(provider: string, model: string, promptLen: number, outputLen: number): number {
  const models = readModels()
  const p = models.providers?.[provider]
  if (!p) return 0
  const m = p.models?.find((x: { id: string }) => x.id === model)
  if (!m) return 0
  const inPrice = typeof m.pricePer1kIn === 'number' ? m.pricePer1kIn : 0
  const outPrice = typeof m.pricePer1kOut === 'number' ? m.pricePer1kOut : 0
  return (promptLen / 1000) * inPrice + (outputLen / 1000) * outPrice
}

export function errClassOf(stderr: string, exitCode: number): ErrorClass {
  if (exitCode === 124) return 'timeout'
  const s = (stderr || '').toLowerCase()
  if (/provider|api|connection|network|timeout|econnreset|econnrefused|unreachable|rate.?limit|429|503|502/.test(s)) {
    return 'provider_down'
  }
  if (/invalid|error:|failed|exception/.test(s)) return 'logic_error'
  return 'unknown'
}
