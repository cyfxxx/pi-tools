import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { WebToolkitConfig } from './types'
import { buildSearchConfig, buildEnvSearchConfig } from './search/config'
import { buildBrowserConfig, buildEnvBrowserConfig } from './browser/config'

const PI_CONFIG_DIR = '.pi'

const DEFAULT_CONFIG: WebToolkitConfig = {
  search: {
    searxng_url: 'https://searx.be',
    timeout: 15000,
  },
  browser: {
    headless: false,
    viewport_width: 1280,
    viewport_height: 800,
  },
}

function readConfigFromFile(): Partial<WebToolkitConfig> {
  const paths = [
    join(homedir(), PI_CONFIG_DIR, 'agent', 'settings.json'),
    join(process.cwd(), PI_CONFIG_DIR, 'settings.json'),
  ]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const ext = (raw?.extensions?.['pi-web-toolkit'] ?? raw?.['pi-web-toolkit']) as Record<string, unknown> | undefined
      if (!ext) continue

      const searchPart = buildSearchConfig(ext)
      const browserPart = buildBrowserConfig(ext)

      return { ...searchPart, ...browserPart }
    } catch {
      continue
    }
  }
  return {}
}

function readConfigFromEnv(): Partial<WebToolkitConfig> {
  const searchPart = buildEnvSearchConfig()
  const browserPart = buildEnvBrowserConfig()
  return { ...searchPart, ...browserPart }
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

export function loadConfig(): WebToolkitConfig {
  const fromFile = readConfigFromFile()
  const fromEnv = readConfigFromEnv()
  return deepMerge(DEFAULT_CONFIG, deepMerge(fromFile, fromEnv))
}
