export type TaskType = 'interval' | 'cron' | 'once'
export type TaskResult = 'success' | 'failed' | null

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
  createdAt: string
  updatedAt: string
}

export interface SchedulerSettings {
  mailTo?: string
  webhookUrl?: string
  defaultMaxRunTime?: number
}

export interface TaskStore {
  version: number
  settings: SchedulerSettings
  tasks: Task[]
}

export const STORE_VERSION = 1
export const TASKS_FILE = 'scheduled-tasks.json'
export const LOCK_FILE = 'scheduler.lock'
export const LOG_DIR = 'logs/scheduler'
export const DEFAULT_MAX_RUN_TIME = 300
