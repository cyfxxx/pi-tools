/**
 * pi-browser helpers — shared utilities for tool registrations
 */
import type { ExtensionContext, AgentToolUpdateCallback, AgentToolResult } from '@earendil-works/pi-coding-agent'
import type { BrowserManager } from './impl'
import { recordOutput, pruneToolOutput } from '../../../services/token-budget/prune.ts'
import { estimateTokens } from '../../../services/token-budget/context-budget.ts'

export type RecordUsage = (name: string, tokens: number) => void

export function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + `\n\n…… [已截断，共 ${s.length} 字符]`
}

export function toolResult(text: string, toolName: string, recordUsage?: RecordUsage): AgentToolResult<Record<string, unknown>> {
  const result = pruneToolOutput(text, toolName)
  recordOutput(toolName, result.length)
  if (recordUsage) recordUsage(toolName, estimateTokens(result))
  return { content: [{ type: 'text' as const, text: result }], details: {} }
}

export function createRequirePage(browser: BrowserManager): () => void {
  return () => {
    if (!browser.isPageActive()) {
      throw new Error('尚未打开任何页面。请先调用 browser_navigate。')
    }
  }
}
