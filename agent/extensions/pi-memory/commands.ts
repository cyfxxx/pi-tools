import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { MemoryCategory } from './types.ts'
import {
  loadEntries,
  searchEntries,
  getStats,
  pruneEntries,
} from './storage.ts'

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('memory:search', {
    description: '搜索持久记忆库。用法: /memory:search <关键词> [--category=<类别>] [--limit=N]',
    usage: '/memory:search <query> [--category=fact|preference|habit|procedure|reference] [--limit=N]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      if (!parts.length || parts[0].startsWith('--')) {
        ctx.ui.notify('用法: /memory:search <关键词> [--category=<类别>] [--limit=N]', 'error')
        return
      }

      let category: MemoryCategory | undefined
      let limit = 5
      const queryParts: string[] = []

      for (const p of parts) {
        if (p.startsWith('--category=')) {
          category = p.slice('--category='.length) as MemoryCategory
        } else if (p.startsWith('--limit=')) {
          limit = parseInt(p.slice('--limit='.length), 10) || 5
        } else {
          queryParts.push(p)
        }
      }

      const entries = loadEntries()
      const results = searchEntries(entries, queryParts.join(' '), category, undefined, limit)

      if (!results.length) {
        ctx.ui.notify('(无匹配的记忆)', 'info')
        return
      }

      const lines = results.map((e, i) => {
        const age = Math.round(
          (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        )
        return `${i + 1}. [${e.category}] ${e.title} (${e.confidence}, ${age}d)`
      })

      ctx.ui.notify(
        `记忆搜索结果 (${results.length}):\n${lines.join('\n')}`,
        'info',
      )
    },
  })

  pi.registerCommand('memory:stats', {
    description: '显示记忆库统计信息：条目数、大小、各类别分布、冷数据比例。',
    usage: '/memory:stats',
    handler: async (_args, ctx) => {
      const entries = loadEntries()
      const stats = getStats(entries)
      const sizeMB = (stats.totalSizeBytes / (1024 * 1024)).toFixed(2)

      const categoryLines = Object.entries(stats.byCategory)
        .map(([cat, count]) => `  ${cat}: ${count}`)
        .join('\n')

      ctx.ui.notify(
        [
          'pi-memory',
          `  条目: ${stats.totalEntries}`,
          `  大小: ${sizeMB} MB / 1 MB`,
          `  冷数据: ${stats.coldEntries}`,
          categoryLines ? `  分类:\n${categoryLines}` : '  (空)',
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('memory:prune', {
    description:
      '清理低价值记忆。删除策略: 置信度<0.3 且 30天未访问 的记忆，' +
      '以及 引用<2 次 且 60天未访问 的记忆。需要确认后执行。',
    usage: '/memory:prune',
    handler: async (_args, ctx) => {
      const entries = loadEntries()
      const stats = getStats(entries)
      if (stats.totalEntries === 0) {
        ctx.ui.notify('记忆库为空，无需清理', 'info')
        return
      }

      const choice = await ctx.ui.confirm(
        '清理低价值记忆？',
        `当前 ${stats.totalEntries} 条，${(stats.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB。\n` +
          '将删除: 置信度<0.3 且 30天未访问 / 引用<2 且 60天未访问 的条目。',
      )
      if (!choice) return

      const removed = pruneEntries(entries)
      ctx.ui.notify(`清理完成，删除了 ${removed} 条低价值记忆`, 'info')
    },
  })
}
