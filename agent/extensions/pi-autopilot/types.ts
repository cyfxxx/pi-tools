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
  /** 软删墓碑：listTasks 过滤不可见、importTasks 拒绝导入；deleteTask 为物理删除，
   *  此字段仅防御陈旧外部副本（导出文件）写回复活（实现于 2026-08-25） */
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

// ── 自主运行配置（extensions/pi-autopilot/.pi-autopilot-config.json） ────────────────
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
  /** 验证触发阈值：失败 N 次后启用 Best-of-N 验证（默认 1） */
  verifyAfter?: number
}

// ── Verifier 配置（LLM-as-a-Verifier 集成） ──────────────────────
export interface VerifierConfig {
  /** 启用验证（默认 false） */
  enabled: boolean
  /** 候选数量（默认 3） */
  nCandidates: number
  /** 失败 N 次后启用验证（默认 1，即首次失败后验证） */
  verifyAfter: number
  /** 最低通过分数（0-1，默认 0.6） */
  threshold: number
  /** 单次验证最大成本 $（默认 0.01） */
  maxCostPerVerify: number
  /** 日志级别：none = 不记录 / summary = 聚合统计 / full = 每次验证详细记录 */
  logLevel: 'none' | 'summary' | 'full'
  /** 验证提示词模板（可选，覆盖默认） */
  judgePrompt?: string
}

export function defaultVerifierConfig(): VerifierConfig {
  return {
    enabled: false,
    nCandidates: 3,
    verifyAfter: 1,
    threshold: 0.6,
    maxCostPerVerify: 0.01,
    logLevel: 'summary',
  }
}

export interface AutopilotConfig {
  enabled: boolean
  fallbackModels: FallbackModel[]
  maxIdleMinutes: number
  requeueOnRestart: boolean
  budget: AutopilotBudget
  policy: AutopilotPolicy
  /** LLM-as-a-Verifier 配置（可选，不配置则不启用验证） */
  verifier?: VerifierConfig
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
  /** v2: 是否经过 Best-of-N 验证 */
  verified?: boolean
  /** v2: 验证选中的候选索引（0-based） */
  verifiedIndex?: number
  /** v2: 验证器打分（0-1） */
  verifiedScore?: number
  /** v2: 验证候选数 */
  verifiedCandidates?: number
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
