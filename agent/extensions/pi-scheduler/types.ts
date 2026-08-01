export type TaskType = 'interval' | 'cron' | 'once'
export type TaskResult = 'success' | 'failed' | null

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

export const STORE_VERSION = 2
export const TASKS_FILE = 'scheduled-tasks.json'
export const LOCK_FILE = 'scheduler.lock'
export const LOG_DIR = 'logs/scheduler'
export const DEFAULT_MAX_RUN_TIME = 300
export const DEFAULT_RETRY_DELAY_MS = 60000
export const HISTORY_LIMIT = 10
