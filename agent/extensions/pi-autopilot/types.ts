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
  /** 后台会话（useSubagent）任务成功完成后，把 stdout 收尾摘要注入主会话提醒（2026-08-24） */
  notifyMain?: boolean
  /** 本地模型（串行推理）时不自动执行，改为注入提示由用户决定（2026-08-24） */
  waitForUserOnLocal?: boolean
  maxRunTime: number
  runCount: number
  history: ExecHistoryEntry[]
  tags: string[]
  retries: number
  failCount: number
  /** failover 熔断计数：连续 failover 次数（只在 success 时重置），>= maxFailovers 后 suspend */
  failoverCount?: number
  pendingInject: boolean
  /** A2: 崩溃恢复重注入累计次数（≥3 转 dead-letter 暂停，需人工介入） */
  recoveryCount?: number
  /** 软删墓碑：writeTasks 写前合并不复活 deleted 任务；listTasks 过滤（2026-08-25） */
  deleted?: boolean
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
  /** failover 熔断：同一任务连续切换模型次数上限（防双模型 ping-pong 无限重启），默认 1 */
  maxFailovers?: number
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
    maxIdleMinutes: 180,
    requeueOnRestart: true,
    budget: { maxRunsPerDay: 50, maxCostPerDay: 0 },
    policy: { failoverAfter: 2, suspendAfter: 5, timeoutFactor: 2 },
  }
}
