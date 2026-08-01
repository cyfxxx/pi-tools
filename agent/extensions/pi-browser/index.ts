import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import type { BrowserOnlyConfig } from './types'
import { BrowserManager } from './browser/impl'
import { registerBrowserTools } from './browser/index'
import { unlink, readdir } from 'fs/promises'
import { join } from 'path'
import { recordToolUsage, resetBudget } from '../../lib/token-budget.ts'
import { resetOutputBudget } from '../../lib/prune.ts'

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
  const config: BrowserOnlyConfig = loadConfig()

  const browser = new BrowserManager(config.browser)

  // Register browser tools
  registerBrowserTools(pi, browser, recordToolUsage, config.browser.viewport_height)

  // ─── lifecycle ───────────────────────────────────────────────
  pi.on('session_shutdown', async () => {
    await browser.close()
    await cleanScreenshots()
  })

  pi.on('session_compact', async () => {
    await trimScreenshots()
  })

  pi.on('session_start', async () => {
    resetBudget()
    resetOutputBudget()
  })
}
