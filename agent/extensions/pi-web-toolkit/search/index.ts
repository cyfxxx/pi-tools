import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback, ToolResult } from '@earendil-works/pi-coding-agent'
import type { SearchConfig } from './types'
import { searchWeb } from './impl'

type RecordUsage = (name: string, tokens: number) => void

export function registerSearchTools(pi: ExtensionAPI, config: SearchConfig, recordUsage: RecordUsage): void {
  pi.registerTool({
    name: 'web_search',
    label: '搜索网络',
    description:
      '使用 SearXNG 私密元搜索引擎搜索网络。支持指定搜索引擎列表、分类过滤、分页、时间范围。自动报告不可用的搜索引擎，支持引擎故障切换。',
    promptSnippet: '搜索网络，支持多引擎、分类、分页和时间范围过滤',
    promptGuidelines: [
      '国内网络推荐 engines: ["baidu","sogou","bing"]，境外用 ["google","bing","duckduckgo"]',
      '如搜索结果不理想，尝试减少 engines 参数或切换 categories',
      '默认返回 5 条结果，使用 max_results:N 查看更多, brief:true 只看标题列表',
    ],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        engines: {
          type: 'array',
          items: { type: 'string' },
          description:
            '指定搜索引擎列表，如 ["google","bing","duckduckgo","brave","qwant","startpage"]。留空则使用 SearXNG 默认配置。当网络环境变化时可切换引擎组合。',
        },
        categories: {
          type: 'string',
          enum: ['general', 'news', 'images', 'videos', 'files', 'map', 'music', 'it', 'science', 'social media'],
          description: '搜索类别，用于缩小搜索范围',
        },
        pageno: { type: 'number', description: '页码，从 1 开始。用于翻页查看更多结果。' },
        time_range: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: '时间范围过滤',
        },
        lang: {
          type: 'string',
          description: '语言代码，如 zh-CN、en-US、ja-JP。指定搜索结果的偏好语言。',
        },
        max_results: {
          type: 'number',
          description: '返回的最大结果数（默认 5）。设为 10 或 20 查看更多。设为 0 使用默认值。',
          default: 5,
        },
        brief: {
          type: 'boolean',
          description: '简要模式：只返回标题和 URL 列表，不包含 snippet。适合快速浏览。',
          default: false,
        },
      },
      required: ['query'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const text = await searchWeb(
        config,
        params.query as string,
        {
          engines: params.engines as string[] | undefined,
          categories: params.categories as string | undefined,
          pageno: params.pageno as number | undefined,
          time_range: params.time_range as string | undefined,
          lang: params.lang as string | undefined,
          max_results: params.max_results as number | undefined,
          brief: params.brief as boolean | undefined,
        },
        signal,
      )
      recordUsage('web_search', estimateTokens(text))
      return toolResult(text)
    },
  })
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '...'
}

function toolResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
