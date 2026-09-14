import crypto from 'node:crypto'
import { loadEntries, storeEntry, deleteEntry, saveEntries, getStats, getTotalSize } from '../storage.ts'
import { detectEnvironment, ENVIRONMENTS, type RuntimeEnv } from '../env.ts'
import { CATEGORIES, type MemoryCategory, type MemoryEntry } from '../types.ts'

export function registerMemoryStoreTools(pi: { registerTool: (def: unknown) => void }): void {
  // ── memory_store ──
  pi.registerTool({
    name: 'memory_store',
    label: '存储知识',
    description:
      '存储知识到持久记忆库（发现新信息/偏好/项目约定/API 用法时调用）。自动去重：同标题更新、近似内容合并。存储后未来会话可检索。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORIES, description: '类别: fact=事实, preference=偏好, habit=习惯, procedure=流程, reference=参考' },
        title: { type: 'string', description: '简短标题，作搜索索引。例: "用户偏好: 使用 Shell 管理系统"' },
        content: { type: 'string', description: '详细内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，用于分类检索' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: '置信度 0-1：直接观察到的事实填 1.0，推断的填 0.5-0.7' },
        environment: {
          type: 'string',
          enum: ENVIRONMENTS as unknown as string[],
          description: '适用运行环境（缺省 all=通用，所有环境可见）。环境专属知识显式指定',
        },
      },
      required: ['category', 'title', 'content'],
    },
    execute: async (_toolCallId: unknown, params: Record<string, unknown>) => {
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
        environments: params.environment ? [params.environment as RuntimeEnv] : ['all'],
      }

      const { action } = storeEntry(entries, entry)
      const totalSize = getTotalSize(entries)

      const actionMap: Record<string, string> = {
        created: '新存入',
        merged: '合并到已有条目',
        updated: '更新已有条目',
      }

      let msg = `已${actionMap[action]}记忆: "${entry.title}" (${entry.category})`
      if (totalSize > 1800 * 1024) {
        msg += `\n警告: 记忆库 ${(totalSize / (1024 * 1024)).toFixed(1)} MB，接近 2 MB 上限，请考虑 /memory prune 清理`
      }

      return { content: [{ type: 'text', text: msg }], details: null }
    },
  })

  // ── memory_stats ──
  pi.registerTool({
    name: 'memory_stats',
    label: '记忆统计',
    description: '查看持久记忆库的统计信息：条目总数、各类别分布、存储大小、冷数据比例、摘要数。',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const entries = loadEntries()
      const stats = getStats(entries)
      const sizeMB = (stats.totalSizeBytes / (1024 * 1024)).toFixed(2)

      const categoryLines = Object.entries(stats.byCategory)
        .map(([cat, count]) => `  ${cat}: ${count} 条`)
        .join('\n')

      return {
        details: [],
        content: [
          {
            type: 'text',
            text: [
              `记忆库统计:`,
              `  总条目: ${stats.totalEntries}（活跃 ${stats.activeEntries}）`,
              `  存储大小: ${sizeMB} MB / 2 MB`,
              `  会话摘要: ${stats.summaries} 条`,
              `  被取代条目: ${stats.superseded} 条`,
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

  // ── memory_forget ──
  pi.registerTool({
    name: 'memory_forget',
    label: '删除记忆',
    description:
      '删除记忆。可指定 id 精确删除，或按类别+时间范围批量删除。删除后不可恢复。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆条目 ID（与 category+olderThan 互斥）' },
        category: { type: 'string', enum: CATEGORIES, description: '按类别批量删除（需同时指定 olderThan）' },
        olderThan: { type: 'string', description: 'ISO 日期，删除该日期之前创建且匹配 category 的记忆。格式: "2026-06-01"' },
      },
    },
    execute: async (_toolCallId: unknown, params: Record<string, unknown>) => {
      const entries = loadEntries()
      const id = params.id as string | undefined
      const category = params.category as MemoryCategory | undefined
      const olderThan = params.olderThan as string | undefined

      if (id) {
        const ok = deleteEntry(entries, id)
        return {
          content: [{ type: 'text', text: ok ? `已删除记忆 ${id}` : `未找到记忆 ${id}` }],
          details: null,
        }
      }

      if (category && olderThan) {
        const cutoff = new Date(olderThan).getTime()
        if (isNaN(cutoff)) {
          return { content: [{ type: 'text', text: `无效日期: ${olderThan}` }], details: null, isError: true }
        }
        const before = entries.length
        const removedIds = new Set<string>()
        const kept = entries.filter(e => {
          if (e.category !== category) return true
          if (new Date(e.createdAt).getTime() > cutoff) return true
          removedIds.add(e.id)
          return false
        })
        const removed = before - kept.length
        entries.length = 0
        entries.push(...kept)
        saveEntries(entries, { excludeIds: removedIds })
        return {
          content: [
            { type: 'text', text: `已删除 ${removed} 条 ${category} 类别记忆（${olderThan} 之前）` },
          ],
          details: null,
        }
      }

      return {
        content: [
          { type: 'text', text: '请指定 id 参数，或同时指定 category 和 olderThan 参数' },
        ],
        details: null,
        isError: true,
      }
    },
  })
}
