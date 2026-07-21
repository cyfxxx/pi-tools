import crypto from 'node:crypto'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { MemoryEntry, MemoryCategory } from './types.ts'
import {
  loadEntries,
  storeEntry,
  searchEntries,
  deleteEntry,
  getStats,
  pruneEntries,
} from './storage.ts'

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'memory_store',
    label: '存储知识',
    description:
      '存储一条知识到持久记忆库。当你在对话中发现新的有用信息、' +
      '用户的偏好/习惯、项目约定、API 使用方法等值得长期记住的内容时调用。' +
      '系统会自动去重：相同标题会更新，内容高度相似会合并。存储后可在未来所有会话中检索。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'habit', 'procedure', 'reference'],
          description:
            '类别: fact=事实, preference=用户偏好, habit=用户习惯, procedure=操作流程, reference=参考信息',
        },
        title: {
          type: 'string',
          description: '简短标题，用作搜索关键词索引。例: "用户偏好: 使用 Shell 管理系统"',
        },
        content: {
          type: 'string',
          description: '详细内容，描述完整的知识信息',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签数组，用于分类检索。例: ["shell", "system", "preference"]',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '置信度 0-1，根据信息可靠程度自评。直接观察到的事实填 1.0，推断的填 0.5-0.7',
        },
      },
      required: ['category', 'title', 'content'],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const entries = loadEntries()

      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        category: params.category as MemoryCategory,
        title: params.title as string,
        content: params.content as string,
        tags: (params.tags as string[]) || [],
        confidence: typeof params.confidence === 'number' ? (params.confidence as number) : 0.7,
        source: 'manual',
        recurrence: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      }

      const { action } = storeEntry(entries, entry)
      const totalSize = entries.reduce(
        (s, e) => s + Buffer.byteLength(e.title + e.content, 'utf-8'),
        0,
      )

      const actionMap: Record<string, string> = {
        created: '新存入',
        merged: '合并到已有条目',
        updated: '更新已有条目',
      }

      let msg = `已${actionMap[action]}记忆: "${entry.title}" (${entry.category})`
      if (totalSize > 900 * 1024) {
        msg += `\n警告: 记忆库 ${(totalSize / (1024 * 1024)).toFixed(1)} MB，接近 1 MB 上限，请考虑 /memory:prune 清理`
      }

      return { content: [{ type: 'text', text: msg }] }
    },
  })

  pi.registerTool({
    name: 'memory_search',
    label: '搜索记忆',
    description:
      '从持久记忆库中搜索已存储的知识。支持按关键词、类别、标签过滤。' +
      '结果按相关度排序（置信度+时效性+引用频率+关键词匹配）。' +
      '当需要回忆之前学到的知识、用户偏好、项目约定时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，匹配标题、标签和内容',
        },
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'habit', 'procedure', 'reference'],
          description: '按类别过滤',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '按标签过滤',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: '返回条数上限（默认 5）',
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const entries = loadEntries()
      const results = searchEntries(
        entries,
        params.query as string | undefined,
        params.category as MemoryCategory | undefined,
        params.tags as string[] | undefined,
        typeof params.limit === 'number' ? (params.limit as number) : 5,
      )

      if (!results.length) {
        return { content: [{ type: 'text', text: '(无匹配的记忆)' }] }
      }

      const lines = results.map((e, i) => {
        const age = Math.round(
          (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        )
        return `${i + 1}. [${e.category}] ${e.title}
   置信度: ${e.confidence} | 引用: ${e.recurrence} 次 | ${age} 天前
   ${e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content}`
      })

      return {
        content: [
          {
            type: 'text',
            text: `记忆搜索结果 (${results.length} 条):\n${lines.join('\n')}`,
          },
        ],
      }
    },
  })

  pi.registerTool({
    name: 'memory_stats',
    label: '记忆统计',
    description: '查看持久记忆库的统计信息：条目总数、各类别分布、存储大小、冷数据比例。',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const entries = loadEntries()
      const stats = getStats(entries)
      const sizeMB = (stats.totalSizeBytes / (1024 * 1024)).toFixed(2)

      const categoryLines = Object.entries(stats.byCategory)
        .map(([cat, count]) => `  ${cat}: ${count} 条`)
        .join('\n')

      return {
        content: [
          {
            type: 'text',
            text: [
              `记忆库统计:`,
              `  总条目: ${stats.totalEntries}`,
              `  存储大小: ${sizeMB} MB / 1 MB`,
              `  冷数据(>30天未访问): ${stats.coldEntries} 条`,
              `  分类:`,
              categoryLines || '  (空)',
              stats.oldestEntry ? `  最早记录: ${stats.oldestEntry.slice(0, 10)}` : '',
              stats.newestEntry ? `  最新记录: ${stats.newestEntry.slice(0, 10)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      }
    },
  })

  pi.registerTool({
    name: 'memory_forget',
    label: '删除记忆',
    description:
      '删除一条或多条记忆。可指定 id 精确删除，或按类别/时间范围批量删除。' +
      '删除后不可恢复。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '要删除的记忆条目 ID。与 category+olderThan 互斥。',
        },
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'habit', 'procedure', 'reference'],
          description: '按类别批量删除。需要同时指定 olderThan。',
        },
        olderThan: {
          type: 'string',
          description:
            'ISO 日期字符串，删除在该日期之前创建且匹配 category 的记忆。格式: "2026-06-01"',
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const entries = loadEntries()
      const id = params.id as string | undefined
      const category = params.category as MemoryCategory | undefined
      const olderThan = params.olderThan as string | undefined

      if (id) {
        const ok = deleteEntry(entries, id)
        return {
          content: [
            {
              type: 'text',
              text: ok ? `已删除记忆 ${id}` : `未找到记忆 ${id}`,
            },
          ],
        }
      }

      if (category && olderThan) {
        const cutoff = new Date(olderThan).getTime()
        if (isNaN(cutoff)) {
          return { content: [{ type: 'text', text: `无效日期: ${olderThan}` }], isError: true }
        }
        const before = entries.length
        const kept = entries.filter(e => {
          if (e.category !== category) return true
          return new Date(e.createdAt).getTime() > cutoff
        })
        const removed = before - kept.length
        entries.length = 0
        entries.push(...kept)
        return {
          content: [
            {
              type: 'text',
              text: `已删除 ${removed} 条 ${category} 类别记忆（${olderThan} 之前）`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: '请指定 id 参数，或同时指定 category 和 olderThan 参数',
          },
        ],
        isError: true,
      }
    },
  })
}
