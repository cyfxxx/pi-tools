export type TaskType = 'interval' | 'cron' | 'once'
export type TaskResult = 'success' | 'failed' | null
export type ErrorClass = 'timeout' | 'provider_down' | 'logic_error' | 'unknown'

export interface ExecHistoryEntry {
  time: string
  result: 'success' | 'failed'
  output: string
  durationMs?: number
}

export interface Task {
  id: string
  name: string
  type: TaskType
  schedule: string
  prompt: string
  enabled: boolean
  lastRun: string | null
  lastResult: TaskResult
  lastOutput: string
  nextRun: string | null
  useSubagent: boolean
  notifyOnCompletion: boolean
  maxRunTime: number
  runCount: number
  history: ExecHistoryEntry[]
  tags: string[]
  retries: number
  failCount: number
  pendingInject: boolean
  /** A2: 崩溃恢复重注入累计次数（≥3 转 dead-letter 暂停，需人工介入） */
  recoveryCount?: number
  createdAt: string
  updatedAt: string
}

export interface SchedulerSettings {
  mailTo?: string
  webhookUrl?: string
  defaultMaxRunTime?: number
  paused?: boolean
}

export interface TaskStore {
  version: number
  settings: SchedulerSettings
  tasks: Task[]
}

// ── 自主运行配置（agent/.pi-autopilot-config.json） ────────────────
export interface FallbackModel {
  provider: string
  model: string
}

export interface AutopilotBudget {
  maxRunsPerDay?: number
  maxCostPerDay?: number
  allowedModels?: string[]
}

export interface AutopilotPolicy {
  failoverAfter?: number
  suspendAfter?: number
  timeoutFactor?: number
}

export interface AutopilotConfig {
  enabled: boolean
  fallbackModels: FallbackModel[]
  maxIdleMinutes: number
  requeueOnRestart: boolean
  budget: AutopilotBudget
  policy: AutopilotPolicy
}

export interface TelemetryEntry {
  ts: string
  taskId: string
  taskName: string
  model: string
  provider: string
  result: 'success' | 'failed'
  durationMs: number
  outputLen: number
  estCost: number
  errClass: ErrorClass | null
}

export interface TelemetryStore {
  runs: TelemetryEntry[]
}

export const STORE_VERSION = 3
export const TASKS_FILE = 'scheduled-tasks.json'
export const LOCK_FILE = 'scheduler.lock'
export const LOG_DIR = 'logs/scheduler'
export const DEFAULT_MAX_RUN_TIME = 300
export const RETRY_BASE_DELAY_MS = 30000  // A1: 重试退避基数（30s）
export const RETRY_MAX_DELAY_MS = 300000  // A1: 重试退避上限（5min）
export const HISTORY_LIMIT = 10
export const CONFIG_FILE = '.pi-autopilot-config.json'
export const TELEMETRY_FILE = '.pi-autopilot-telemetry.json'
export const LASTGOOD_FILE = '.pi-autopilot-lastgood.json'
export const CRASH_FILE = '.pi-autopilot-crash.json'
export const TELEMETRY_LIMIT = 1000

export function defaultAutopilotConfig(): AutopilotConfig {
  return {
    enabled: true,
    fallbackModels: [],
    maxIdleMinutes: 30,
    requeueOnRestart: true,
    budget: { maxRunsPerDay: 50, maxCostPerDay: 0 },
    policy: { failoverAfter: 2, suspendAfter: 5, timeoutFactor: 2 },
  }
}
