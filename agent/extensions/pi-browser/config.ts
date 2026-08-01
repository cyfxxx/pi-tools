import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { BrowserOnlyConfig } from './types'
import { buildBrowserConfig, buildEnvBrowserConfig } from './browser/config'

const DEFAULT_CONFIG: BrowserOnlyConfig = {
  browser: {
    headless: false,
    viewport_width: 1280,
    viewport_height: 800,
  },
}

// 兼容旧配置段：拆分前浏览器配置位于 pi-web-toolkit 段，读取时回退
const CONFIG_KEYS = ['pi-browser', 'pi-web-toolkit'] as const

function readConfigFromFile(): Partial<BrowserOnlyConfig> {
  const paths = [
    join(getAgentDir(), 'settings.json'),
    join(process.cwd(), '.pi', 'settings.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const sections = CONFIG_KEYS
        .map(k => raw?.extensions?.[k] ?? raw?.[k])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      if (sections.length === 0) continue

      const merged = Object.assign({}, ...sections.reverse()) as Record<string, unknown>
      const browserPart = buildBrowserConfig(merged)

      return deepMerge({} as Partial<BrowserOnlyConfig>, browserPart)
    } catch {
      continue
    }
  }
  return {}
}

function readConfigFromEnv(): Partial<BrowserOnlyConfig> {
  return buildEnvBrowserConfig()
}

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const val = override[key as keyof T]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key as keyof T] = deepMerge(result[key as keyof T] as any, val as any)
    } else if (val !== undefined) {
      result[key as keyof T] = val as any
    }
  }
  return result
}

export function loadConfig(): BrowserOnlyConfig {
  const fromFile = readConfigFromFile()
  const fromEnv = readConfigFromEnv()
  return deepMerge(DEFAULT_CONFIG, deepMerge(fromFile, fromEnv))
}
