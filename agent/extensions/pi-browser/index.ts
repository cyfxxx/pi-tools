import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig } from './config'
import type { BrowserOnlyConfig } from './types'
import { BrowserManager, shotDir, pdfDir, downloadsDirDefault } from './browser/impl'
import { registerBrowserTools } from './browser/index'
import { unlink, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { recordToolUsage, resetBudget } from '../../lib/token-budget.ts'
import { resetOutputBudget } from '../../lib/prune.ts'

const SCREENSHOT_PREFIX = 'pi-screenshot-'
const MAX_SCREENSHOTS = 20

async function cleanScreenshots(): Promise<void> {
  try {
    const dir = shotDir()
    const files = await readdir(dir)
    await Promise.all(
      files
        .filter(f => f.startsWith(SCREENSHOT_PREFIX))
        .map(f => unlink(join(dir, f)).catch(() => {}))
    )
  } catch { /* ignore */ }
}

/** PDF 暂存目录整目录清理（含 pid 子目录本身；rm force：不存在时静默）。 */
async function cleanPdf(): Promise<void> {
  try {
    await rm(pdfDir(), { recursive: true, force: true })
  } catch { /* ignore */ }
}

/**
 * 下载目录整目录清理（与 pdfDir 同为 pid 隔离的 tmpdir 子目录，进程退出后
 * 残留会积累——2026-08-25 文档同步时发现文案承诺 shutdown 清理但实现缺失）。
 */
async function cleanDownloads(): Promise<void> {
  try {
    await rm(downloadsDirDefault(), { recursive: true, force: true })
  } catch { /* ignore */ }
}

/**
 * 崩溃残留清扫（session_start）：shutdown 只清本 pid 目录，崩溃/被杀进程的
 * pi-browser-{screenshots,pdf,downloads}-<pid> 会永久累积。仅删同时满足：
 * 匹配 pi-browser-*-数字 模式、非当前 pid、pid 非存活进程（process.kill(pid,0)
 * 探活，ESRCH=不存在；EPERM=存在无权信号 → 视为存活不删，防误杀活跃实例）。
 */
export async function cleanStaleTempDirs(): Promise<void> {
  const pattern = /^pi-browser-(?:screenshots|pdf|downloads)-(\d+)$/
  try {
    const entries = await readdir(tmpdir())
    await Promise.all(entries.map(async name => {
      const m = name.match(pattern)
      if (!m) return
      const pid = Number(m[1])
      if (pid === process.pid || pid <= 0) return
      try {
        process.kill(pid, 0) // 探活：不发信号，仅检测存在性
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          await rm(join(tmpdir(), name), { recursive: true, force: true }).catch(() => {})
        }
        // EPERM 等其他错误：进程存在但不可探活 → 不删
      }
    }))
  } catch { /* ignore */ }
}

async function trimScreenshots(): Promise<void> {
  try {
    const dir = shotDir()
    const files = (await readdir(dir))
      .filter(f => f.startsWith(SCREENSHOT_PREFIX))
      .sort()
    if (files.length > MAX_SCREENSHOTS) {
      await Promise.all(
        files
          .slice(0, files.length - MAX_SCREENSHOTS)
          .map(f => unlink(join(dir, f)).catch(() => {}))
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
    await cleanPdf()
    await cleanDownloads()
  })

  pi.on('session_compact', async () => {
    await trimScreenshots()
  })

  pi.on('session_start', async () => {
    resetBudget()
    resetOutputBudget()
    void cleanStaleTempDirs() // 后台清扫崩溃残留，不阻塞会话启动
  })
}
