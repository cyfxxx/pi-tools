/**
 * pi-browser — 浏览器工具注册入口
 *
 * 注册 18 个浏览器操作工具：
 * - 导航：navigate, screenshot, click, type, scroll
 * - 提取：extract, evaluate, find
 * - 高级：wait_for, network, select_option, dialog, download, upload, cookies
 * - 工具：pdf, help, close
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { BrowserConfig } from './types'
import { BrowserManager } from './impl'
import { recordOutput, pruneToolOutput } from '../../../lib/prune.ts'
import { estimateTokens } from '../../../lib/context-budget.ts'
import { registerNavigationTools } from './tools/navigation'
import { registerExtractionTools } from './tools/extraction'
import { registerAdvancedTools } from './tools/advanced'
import { registerUtilityTools } from './tools/utility'

type RecordUsage = (name: string, tokens: number) => void

export function registerBrowserTools(pi: ExtensionAPI, browser: BrowserManager, recordUsage: RecordUsage, viewportHeight: number = 800): void {
  registerNavigationTools(pi, browser, recordUsage, viewportHeight)
  registerExtractionTools(pi, browser, recordUsage)
  registerAdvancedTools(pi, browser, recordUsage)
  registerUtilityTools(pi, browser, recordUsage)
}
