import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { SearchOnlyConfig } from './types'
import { buildSearchConfig, buildEnvSearchConfig } from './search/config'

const DEFAULT_CONFIG: SearchOnlyConfig = {
  search: {
    searxng_url: 'https://searx.be',
    timeout: 15000,
  },
}

// 兼容旧配置段：拆分前搜索配置位于 pi-web-toolkit 段，读取时回退
const CONFIG_KEYS = ['pi-web-search', 'pi-web-toolkit'] as const

function readConfigFromFile(): Partial<SearchOnlyConfig> {
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
      const searchPart = buildSearchConfig(merged)

      return deepMerge({} as Partial<SearchOnlyConfig>, searchPart)
    } catch {
      continue
    }
  }
  return {}
}

function readConfigFromEnv(): Partial<SearchOnlyConfig> {
  return buildEnvSearchConfig()
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

export function loadConfig(): SearchOnlyConfig {
  const fromFile = readConfigFromFile()
  const fromEnv = readConfigFromEnv()
  return deepMerge(DEFAULT_CONFIG, deepMerge(fromFile, fromEnv))
}
