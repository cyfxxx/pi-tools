import type { BrowserConfig } from './types'

export function buildBrowserConfig(ext: Record<string, unknown>): Partial<{ browser: BrowserConfig }> {
  const r: Partial<{ browser: BrowserConfig }> = {}
  const b: Record<string, unknown> = {}
  if (ext.headless != null) b.headless = ext.headless
  if (ext.viewport_width != null) b.viewport_width = ext.viewport_width
  if (ext.viewport_height != null) b.viewport_height = ext.viewport_height
  if (ext.fingerprint_seed != null) b.fingerprint_seed = ext.fingerprint_seed
  if (ext.proxy != null) b.proxy = ext.proxy
  if (ext.data_dir != null) b.data_dir = ext.data_dir
  if (Object.keys(b).length > 0) r.browser = b as unknown as BrowserConfig
  return r
}

/**
 * 按优先级取首个非空环境变量：先读新前缀 PI_BROWSER_*，回退旧前缀 PI_WEB_TOOLKIT_*。
 * 审计 LOW：旧前缀仅作向后兼容回退，不破坏既有部署的同名变量仍生效。
 */
function envFirst(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

// 新旧前缀键对（新前缀优先）：PI_BROWSER_* → PI_WEB_TOOLKIT_*（回退）
type EnvKey = 'headless' | 'viewport_width' | 'viewport_height' | 'fingerprint_seed' | 'proxy'
const ENV_PREFIX_PAIRS: Record<EnvKey, [string, string]> = {
  headless: ['PI_BROWSER_HEADLESS', 'PI_WEB_TOOLKIT_HEADLESS'],
  viewport_width: ['PI_BROWSER_VIEWPORT_WIDTH', 'PI_WEB_TOOLKIT_VIEWPORT_WIDTH'],
  viewport_height: ['PI_BROWSER_VIEWPORT_HEIGHT', 'PI_WEB_TOOLKIT_VIEWPORT_HEIGHT'],
  fingerprint_seed: ['PI_BROWSER_FINGERPRINT_SEED', 'PI_WEB_TOOLKIT_FINGERPRINT_SEED'],
  proxy: ['PI_BROWSER_PROXY', 'PI_WEB_TOOLKIT_PROXY'],
}

export function buildEnvBrowserConfig(): Partial<{ browser: BrowserConfig }> {
  const b: Record<string, unknown> = {}
  const headless = envFirst(...ENV_PREFIX_PAIRS.headless)
  if (headless) b.headless = headless === 'true'
  const vw = envFirst(...ENV_PREFIX_PAIRS.viewport_width)
  if (vw) {
    const v = parseInt(vw)
    if (!Number.isNaN(v)) b.viewport_width = v
  }
  const vh = envFirst(...ENV_PREFIX_PAIRS.viewport_height)
  if (vh) {
    const v = parseInt(vh)
    if (!Number.isNaN(v)) b.viewport_height = v
  }
  const fp = envFirst(...ENV_PREFIX_PAIRS.fingerprint_seed)
  if (fp) b.fingerprint_seed = fp
  const proxy = envFirst(...ENV_PREFIX_PAIRS.proxy)
  if (proxy) b.proxy = proxy
  if (Object.keys(b).length > 0) return { browser: b as unknown as BrowserConfig }
  return {}
}
