import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import type { WebToolkitConfig } from './types'
import type { ProxyPool } from './proxy/pool'
import { BrowserManager } from './browser/impl'
import { registerSearchTools } from './search/index'
import { registerBrowserTools } from './browser/index'
import { registerProxyControlTools } from './proxy/index'
import { unlink, readdir } from 'fs/promises'
import { join } from 'path'
import { recordToolUsage, resetBudget, estimateTokens } from '../../lib/token-budget.ts'

const SCREENSHOT_PREFIX = 'pi-screenshot-'
const MAX_SCREENSHOTS = 20

async function cleanScreenshots(): Promise<void> {
  try {
    const files = await readdir('/tmp')
    await Promise.all(
      files
        .filter(f => f.startsWith(SCREENSHOT_PREFIX))
        .map(f => unlink(join('/tmp', f)).catch(() => {}))
    )
  } catch { /* ignore */ }
}

async function trimScreenshots(): Promise<void> {
  try {
    const files = (await readdir('/tmp'))
      .filter(f => f.startsWith(SCREENSHOT_PREFIX))
      .sort()
    if (files.length > MAX_SCREENSHOTS) {
      await Promise.all(
        files
          .slice(0, files.length - MAX_SCREENSHOTS)
          .map(f => unlink(join('/tmp', f)).catch(() => {}))
      )
    }
  } catch { /* ignore */ }
}

export default async function (pi: ExtensionAPI) {
  const config: WebToolkitConfig = loadConfig()

  // Proxy pool: lazily imported + deferred init on first proxy tool use
  let proxyPool: ProxyPool | null = null
  let proxyPoolInit: Promise<void> | null = null
  if (config.proxy_pool) {
    const { ProxyPool: PP } = await import('./proxy/pool')
    proxyPool = new PP(config.proxy_pool) as unknown as ProxyPool
    proxyPoolInit = proxyPool.init().catch((e) => {
      console.error(`[pi-web-toolkit] 代理池启动失败: ${(e as Error).message}，IP 池功能不可用`)
      proxyPool = null
      proxyPoolInit = null
    })
  }
  async function ensureProxy(): Promise<boolean> {
    if (proxyPoolInit) { await proxyPoolInit; proxyPoolInit = null }
    return proxyPool !== null
  }

  // Pass proxy pool lazy getter — browser will resolve proxy URL only when launching
  const browser = new BrowserManager(config.browser, () => proxyPool?.getLocalProxyUrl() ?? null)

  // Register feature tools
  registerSearchTools(pi, config.search, recordToolUsage)
  registerBrowserTools(pi, browser, recordToolUsage, config.browser.viewport_height)

  const proxyConfigured = !!config.proxy_pool
  if (proxyConfigured) {
    registerProxyControlTools(pi, ensureProxy, proxyPool)
  }

  // ─── lifecycle ───────────────────────────────────────────────
  pi.on('session_shutdown', async () => {
    await browser.close()
    if (proxyPool) proxyPool.stop()
    await cleanScreenshots()
  })

  pi.on('session_compact', async () => {
    await trimScreenshots()
  })

  pi.on('session_start', async () => {
    resetBudget()
  })
}
