import type { BrowserConfig } from './types'

export function buildBrowserConfig(ext: Record<string, unknown>): Partial<{ browser: BrowserConfig }> {
  const r: Partial<{ browser: BrowserConfig }> = {}
  const b: Record<string, unknown> = {}
  if (ext.headless != null) b.headless = ext.headless
  if (ext.viewport_width) b.viewport_width = ext.viewport_width
  if (ext.viewport_height) b.viewport_height = ext.viewport_height
  if (ext.fingerprint_seed) b.fingerprint_seed = ext.fingerprint_seed
  if (ext.proxy) b.proxy = ext.proxy
  if (ext.data_dir) b.data_dir = ext.data_dir
  if (Object.keys(b).length > 0) r.browser = b as unknown as BrowserConfig
  return r
}

export function buildEnvBrowserConfig(): Partial<{ browser: BrowserConfig }> {
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
  if (Object.keys(b).length > 0) return { browser: b as unknown as BrowserConfig }
  return {}
}
