import fs from 'node:fs'
import path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const AGENT_DIR = getAgentDir()
const SETTINGS_PATH = path.join(AGENT_DIR, 'settings.json')
const MODELS_PATH = path.join(AGENT_DIR, 'models.json')

export interface Settings {
  [key: string]: unknown
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: string
  extensions?: string[]
}

export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  [key: string]: unknown
}

export interface ProviderInfo {
  name: string
  baseUrl?: string
  api?: string
  models: ModelInfo[]
  [key: string]: unknown
}

function readJSON<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJSON(filePath: string, data: unknown): boolean {
  try {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    // 审计 MEDIUM 修复：tmp 带 pid 隔离，避免并发写互踩（同 autoconfig.ts；
    // RMW 丢更新需文件锁根治，此处调用频率低先解决互踩半边）
    const tmp = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
    return true
  } catch (e) {
    console.error('[pi-admin] 写配置文件失败:', e)
    return false
  }
}

export function readSettings(): Settings {
  return readJSON<Settings>(SETTINGS_PATH) || {}
}

export function writeSettings(settings: Settings): boolean {
  return writeJSON(SETTINGS_PATH, settings)
}

export function updateSettings(key: string, value: unknown): { success: boolean; error?: string } {
  const settings = readSettings()
  settings[key] = value
  if (!writeSettings(settings)) {
    return { success: false, error: '写 settings.json 失败' }
  }
  return { success: true }
}

export function updateModelConfig(provider: string, modelId: string): { success: boolean; error?: string } {
  const models = readModels()
  const providerData = models.providers?.[provider]
  if (!providerData) {
    return { success: false, error: `Provider "${provider}" 不存在` }
  }
  const modelExists = providerData.models?.some((m: ModelInfo) => m.id === modelId)
  if (!modelExists) {
    return { success: false, error: `模型 "${modelId}" 不在 provider "${provider}" 的模型列表中` }
  }
  const settings = readSettings()
  settings.defaultProvider = provider
  settings.defaultModel = modelId
  if (!writeSettings(settings)) {
    return { success: false, error: '写 settings.json 失败' }
  }
  return { success: true }
}

export function readModels(): { providers?: Record<string, ProviderInfo> } {
  return readJSON<{ providers?: Record<string, ProviderInfo> }>(MODELS_PATH) || {}
}

export function listAvailableModels(): ProviderInfo[] {
  const data = readModels()
  if (!data.providers) return []
  return Object.entries(data.providers).map(([name, p]) => ({
    name,
    baseUrl: p.baseUrl,
    api: p.api,
    models: p.models || [],
  }))
}

export function safeConfigKeys(): string[] {
  return [
    'defaultThinkingLevel',
    'steeringMode',
    'followUpMode',
    'packages',
    'hideThinkingBlock',
    'collapseChangelog',
    'theme',
    'defaultProjectTrust',
  ]
}

export function getSettingsPath(): string {
  return SETTINGS_PATH
}

export function isSensitiveKey(key: string): boolean {
  return /key|token|secret|password|auth/i.test(key.toLowerCase())
}