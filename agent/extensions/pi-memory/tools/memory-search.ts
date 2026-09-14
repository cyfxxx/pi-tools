import { loadEntries, touchAccessedAt, loadSummaries } from '../storage.ts'
import { logSearchTrace, searchEntriesWithScores } from '../retrieval.ts'
import { detectEnvironment, formatEnvironments } from '../env.ts'
import { CATEGORIES, type MemoryCategory } from '../types.ts'
import type { RuntimeEnv } from '../env.ts'

export function registerMemorySearchTools(pi: { registerTool: (def: unknown) => void }): void {
  // ── memory_search ──
  pi.registerTool({
    name: 'memory_search',
    label: '搜索记忆',
    description:
      '从持久记忆库检索知识。支持关键词/类别/标签过滤，结果按相关度排序（BM25 + 置信度/时效/引用频率）。回忆知识/偏好/项目约定时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，匹配标题、标签和内容' },
        category: { type: 'string', enum: CATEGORIES, description: '按类别过滤' },
        tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数上限（默认 5）' },
        env: {
          type: 'string',
          enum: ['all', 'termux', 'wsl2', 'linux', 'macos', 'windows'] as unknown as string[],
          description: '按运行环境过滤（缺省=当前环境+all；传 all 则不过滤）',
        },
        asOf: { type: 'string', description: 'ISO 时间点：返回在该时刻有效的记忆（回溯查询，含被后来取代的旧事实；缺省=当前态）' },
      },
    },
    execute: async (_toolCallId: unknown, params: Record<string, unknown>) => {
      const __t0 = Date.now()
      const entries = loadEntries()
      const currentEnv = detectEnvironment()
      const envFilter: RuntimeEnv | 'all' = params.env ? (params.env as RuntimeEnv) : currentEnv
      const scored = searchEntriesWithScores(
        entries,
        params.query as string | undefined,
        params.category as MemoryCategory | undefined,
        params.tags as string[] | undefined,
        typeof params.limit === 'number' ? (params.limit as number) : 5,
        envFilter,
        typeof params.asOf === 'string' ? (params.asOf as string) : undefined,
      )
      const results = scored.map(x => x.entry)
      touchAccessedAt(entries, results.map(e => e.id))
      logSearchTrace({
        caller: 'memory_search',
        query: params.query as string | undefined,
        category: params.category as string | undefined,
        tags: params.tags as string[] | undefined,
        limit: typeof params.limit === 'number' ? (params.limit as number) : 5,
        hits: scored.map(x => ({ id: x.entry.id, title: x.entry.title, score: x.score })),
        tookMs: Date.now() - __t0,
      })

      if (!results.length) {
        return { content: [{ type: 'text', text: '(无匹配的记忆)' }], details: null }
      }

      const lines = results.map((e, i) => {
        const age = Math.round(
          (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        )
        const linkNote = e.links?.length ? ` ↔关联${e.links.length}条` : ''
        return `${i + 1}. [${e.category}] ${e.title}（${formatEnvironments(e.environments)}）${linkNote}
   置信度: ${e.confidence} | 引用: ${e.recurrence} 次 | ${age} 天前
   ${e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content}`
      })

      return {
        content: [{ type: 'text', text: `记忆搜索结果 (${results.length} 条):\n${lines.join('\n')}` }],
        details: null,
      }
    },
  })

  // ── memory_recall ──
  pi.registerTool({
    name: 'memory_recall',
    label: '回忆记忆与摘要',
    description:
      '综合检索长期记忆与历史会话摘要。query 匹配记忆条目（BM25 + 质量分）；附带 --summaries 时同时返回最近会话摘要时间线，用于跨会话衔接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（可空：仅返回高质量记忆）' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '记忆条数上限（默认 3）' },
        summaries: { type: 'boolean', description: '是否附带最近会话摘要（默认 false）' },
      },
    },
    execute: async (_toolCallId: unknown, params: Record<string, unknown>) => {
      const __t0 = Date.now()
      const entries = loadEntries()
      const limit = typeof params.limit === 'number' ? (params.limit as number) : 3
      const scored = searchEntriesWithScores(
        entries,
        params.query as string | undefined,
        undefined,
        undefined,
        limit,
        detectEnvironment(),
      )
      const results = scored.map(x => x.entry)
      touchAccessedAt(entries, results.map(e => e.id))
      logSearchTrace({
        caller: 'memory_recall',
        query: params.query as string | undefined,
        limit,
        hits: scored.map(x => ({ id: x.entry.id, title: x.entry.title, score: x.score })),
        tookMs: Date.now() - __t0,
      })

      const blocks: string[] = []
      if (results.length) {
        blocks.push(
          '相关记忆:\n' +
            results
              .map((e, i) => `${i + 1}. [${e.category}] ${e.title}: ${e.content.slice(0, 200)}`)
              .join('\n'),
        )
      } else {
        blocks.push('(无相关记忆)')
      }

      if (params.summaries === true) {
        const summaries = [...loadSummaries()].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 5)
        if (summaries.length) {
          blocks.push(
            '最近会话摘要:\n' +
              summaries
                .map(
                  (s, i) =>
                    `${i + 1}. ${s.ts.slice(0, 10)} 「${s.title}」 — ${s.fullText.slice(0, 150)}`,
                )
                .join('\n'),
          )
        } else {
          blocks.push('(暂无会话摘要)')
        }
      }

      return { content: [{ type: 'text', text: blocks.join('\n\n') }], details: null }
    },
  })
}
