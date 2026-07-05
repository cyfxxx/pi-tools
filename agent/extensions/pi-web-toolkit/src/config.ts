import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import type { WebToolkitConfig, ProxyPoolConfig } from './types'

const _require = createRequire(import.meta.url)
const PI_CONFIG_DIR =
  (() => {
    try {
      return (_require('@earendil-works/pi-coding-agent') as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? '.pi'
    } catch {
      return '.pi'
    }
  })()

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

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1))
  }
  return p
}

export function loadConfig(): WebToolkitConfig {
  const fromFile = readConfigFromFile()
  const fromEnv = readConfigFromEnv()
  return deepMerge(DEFAULT_CONFIG, deepMerge(fromFile, fromEnv))
}

function buildSearchConfig(ext: Record<string, unknown>): Partial<WebToolkitConfig> {
  const r: Partial<WebToolkitConfig> = {}
  const s: { searxng_url?: string; timeout?: number } = {}
  if (ext.searxng_url) s.searxng_url = ext.searxng_url as string
  if (ext.search_timeout) s.timeout = ext.search_timeout as number
  if (Object.keys(s).length > 0) r.search = s as WebToolkitConfig['search']
  return r
}

function buildBrowserConfig(ext: Record<string, unknown>): Partial<WebToolkitConfig> {
  const r: Partial<WebToolkitConfig> = {}
  const b: Record<string, unknown> = {}
  if (ext.headless != null) b.headless = ext.headless
  if (ext.viewport_width) b.viewport_width = ext.viewport_width
  if (ext.viewport_height) b.viewport_height = ext.viewport_height
  if (ext.fingerprint_seed) b.fingerprint_seed = ext.fingerprint_seed
  if (ext.proxy) b.proxy = ext.proxy
  if (ext.data_dir) b.data_dir = ext.data_dir
  if (Object.keys(b).length > 0) r.browser = b as unknown as WebToolkitConfig['browser']
  return r
}

function buildProxyPoolConfig(ext: Record<string, unknown>): Partial<WebToolkitConfig> {
  const pp = ext.proxy_pool as Record<string, unknown> | undefined
  if (!pp) return {}

  const sbCfg = (pp.sing_box || pp.mihomo) as Record<string, unknown> | undefined
  const piDir = join(homedir(), PI_CONFIG_DIR)

  const sourceUrls = pp.subscription_urls
    ? pp.subscription_urls as string[]
    : pp.v2ray_source_urls
      ? pp.v2ray_source_urls as string[]
      : pp.proxy_source_urls
        ? pp.proxy_source_urls as string[]
        : undefined

  const pool: ProxyPoolConfig = {
    enabled: pp.enabled !== false,
    sing_box: {
      binary_path: expandHome((sbCfg?.binary_path || join(piDir, 'sing-box', 'sing-box')) as string),
      work_dir: expandHome((sbCfg?.work_dir || join(piDir, 'sing-box', 'run')) as string),
      mixed_port: (pp.local_proxy_port ?? sbCfg?.mixed_port ?? 19998) as number,
      external_controller_port: (sbCfg?.external_controller_port ?? 9090) as number,
      log_level: (sbCfg?.log_level || 'error') as string,
    },
    subscription_urls: sourceUrls || [],
    proxies: pp.proxies as string[] | undefined,
    strategy: (pp.strategy || 'round-robin') as 'random' | 'round-robin' | 'latency',
    health_check_url: (pp.health_check_url || 'http://httpbin.org/ip') as string,
    health_check_interval: (pp.health_check_interval ?? 300) as number,
    fallback_direct: pp.fallback_direct !== false,
  }

  return { proxy_pool: pool }
}

function buildEnvSearchConfig(): Partial<WebToolkitConfig> {
  const s: { searxng_url?: string; timeout?: number } = {}
  if (process.env.PI_WEB_TOOLKIT_SEARXNG_URL) {
    s.searxng_url = process.env.PI_WEB_TOOLKIT_SEARXNG_URL
  }
  if (process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT) {
    const v = parseInt(process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT)
    if (!Number.isNaN(v)) s.timeout = v
  }
  if (Object.keys(s).length > 0) return { search: s as WebToolkitConfig['search'] }
  return {}
}

function buildEnvBrowserConfig(): Partial<WebToolkitConfig> {
  const b: Record<string, unknown> = {}
  if (process.env.PI_WEB_TOOLKIT_HEADLESS) {
    b.headless = process.env.PI_WEB_TOOLKIT_HEADLESS === 'true'
  }
  if (process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH) {
    const v = parseInt(process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH)
    if (!Number.isNaN(v)) b.viewport_width = v
  }
  if (process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT) {
    const v = parseInt(process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT)
    if (!Number.isNaN(v)) b.viewport_height = v
  }
  if (process.env.PI_WEB_TOOLKIT_FINGERPRINT_SEED) {
    b.fingerprint_seed = process.env.PI_WEB_TOOLKIT_FINGERPRINT_SEED
  }
  if (process.env.PI_WEB_TOOLKIT_PROXY) {
    b.proxy = process.env.PI_WEB_TOOLKIT_PROXY
  }
  if (Object.keys(b).length > 0) return { browser: b as unknown as WebToolkitConfig['browser'] }
  return {}
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
      const poolPart = buildProxyPoolConfig(ext)

      return { ...searchPart, ...browserPart, ...poolPart }
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
