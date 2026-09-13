/**
 * pi-browser tools/utility — pdf, help, close
 */
import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent'
import type { BrowserManager } from '../impl'
import type { RecordUsage } from '../helpers'
import { truncate, toolResult } from '../helpers'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'

const REFERENCES_DIR = fileURLToPath(new URL('../../references/', import.meta.url))
const INTERACTION_DOC = `${REFERENCES_DIR}interaction.md`

export function registerUtilityTools(pi: ExtensionAPI, browser: BrowserManager, recordUsage: RecordUsage): void {
  // ─── browser_pdf ────────────────────────────────────────────
  pi.registerTool({
    name: 'browser_pdf',
    label: '导出 PDF',
    description: '将当前页面打印为 PDF 并保存到本地路径（默认 /tmp/pi-browser-pdf-<pid>/），返回文件路径。适用于导出页面为离线文档。',
    promptSnippet: '把当前页导出为 PDF',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'PDF 保存路径（可选，默认自动生成）',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!browser.isPageActive()) {
        throw new Error('尚未打开任何页面。请先调用 browser_navigate。')
      }
      const path = await browser.exportPdf(params.path as string | undefined)
      return toolResult(`PDF 已导出：\`${path}\``, 'browser_pdf', recordUsage)
    },
  })

  // ─── browser_help ──────────────────────────────────────────
  pi.registerTool({
    name: 'browser_help',
    label: '浏览器交互手册',
    description:
      '查询 pi-browser 的 Web 交互手册（坐标转换、Shadow DOM、下拉框、弹窗、下载/上传、网络捕获、滚动、iframe、等待、cookie、截图），返回处理对应浏览器机制的实操要领。当页面交互不确定时按需查询。',
    promptSnippet: '查询浏览器交互机制手册（按需）',
    promptGuidelines: [
      '遇到坐标错位、shadow 元素点不到、下拉/弹窗/下载等不确定时先查对应主题',
      'topic 可选，如 shadow、dropdown、dialog、download、network、scroll、iframe、wait、cookie、screenshot',
    ],
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: '要查询的主题（可选）：shadow/dropdown/dialog/download/network/scroll/iframe/wait/cookie/screenshot 等',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      let doc: string
      try {
        doc = await readFile(INTERACTION_DOC, 'utf8')
      } catch {
        return toolResult('交互手册未找到（references/interaction.md 缺失）。', 'browser_help', recordUsage)
      }
      const topic = (params.topic as string | undefined)?.trim()
      if (topic) {
        const marker = `## ${topic}${topic.toLowerCase() === 'iframe' ? '' : ''}`
        const idx = doc.toLowerCase().indexOf(marker.toLowerCase())
        if (idx >= 0) {
          const rest = doc.slice(idx)
          const next = rest.search(/\n## /)
          const section = next > 0 ? rest.slice(0, next) : rest
          return toolResult(truncate(section.trim(), 3000), 'browser_help', recordUsage)
        }
        return toolResult(`未找到主题「${topic}」。可用主题见手册全文，标题包括：坐标/截图、Shadow DOM、下拉框、弹窗、下载、网络、滚动、iframe、等待、Cookie。\n\n${truncate(doc, 500)}`, 'browser_help', recordUsage)
      }
      return toolResult(truncate(doc, 8000), 'browser_help', recordUsage)
    },
  })

  // ─── browser_close ───────────────────────────────────────────
  pi.registerTool({
    name: 'browser_close',
    label: '关闭浏览器',
    description: '关闭当前浏览器实例，释放系统资源。在不再需要浏览器操作时调用。',
    promptSnippet: '关闭浏览器，释放系统资源',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await browser.close()
      const text = '浏览器实例已关闭，资源已释放。'
      return toolResult(text, "browser_close", recordUsage)
    },
  })
}
