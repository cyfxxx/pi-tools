import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { MemoryCategory } from './types.ts'
import {
  loadEntries,
  loadNotes,
  saveNotes,
  loadSummaries,
  getStats,
  pruneEntries,
  CHECKPOINTS_DIR,
  getNotesSize,
} from './storage.ts'
import { searchEntries } from './retrieval.ts'

const CATEGORY_HINT =
  '类别: fact|preference|habit|procedure|reference'

export function registerCommands(pi: ExtensionAPI): void {
  // ── /memory（统一命令，子命令: search|stats|summary|prune|cleanup） ──
  pi.registerCommand('memory', {
    description:
      '管理持久记忆库。子命令: search <关键词> [--category=] [--limit=N] 搜索；' +
      'stats 统计；summary [N] 会话摘要时间线；prune 清理低价值记忆；' +
      'cleanup [--keep=N] [--dry-run] 清理过期笔记/检查点，--all 清除全部。',
    usage: '/memory <search|stats|summary|prune|cleanup> [args...]',
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'search'

      // ── search ──
      if (subcmd === 'search') {
        const queryParts = parts.slice(1).filter(p => !p.startsWith('--'))
        if (!queryParts.length) {
          ctx.ui.notify(`用法: /memory search <关键词> [--category=<类别>] [--limit=N]\n${CATEGORY_HINT}`, 'error')
          return
        }
        let category: MemoryCategory | undefined
        let limit = 5
        for (const p of parts.slice(1)) {
          if (p.startsWith('--category=')) {
            category = p.slice('--category='.length) as MemoryCategory
          } else if (p.startsWith('--limit=')) {
            limit = Math.min(Math.max(parseInt(p.slice('--limit='.length), 10) || 5, 1), 50)
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
        ctx.ui.notify(`记忆搜索结果 (${results.length}):\n${lines.join('\n')}`, 'info')
        return
      }

      // ── stats ──
      if (subcmd === 'stats') {
        const entries = loadEntries()
        const stats = getStats(entries)
        const sizeMB = (stats.totalSizeBytes / (1024 * 1024)).toFixed(2)
        const categoryLines = Object.entries(stats.byCategory)
          .map(([cat, count]) => `  ${cat}: ${count}`)
          .join('\n')
        ctx.ui.notify(
          [
            'pi-memory',
            `  条目: ${stats.totalEntries}（活跃 ${stats.activeEntries}）`,
            `  大小: ${sizeMB} MB / 1 MB`,
            `  会话摘要: ${stats.summaries} 条`,
            `  被取代: ${stats.superseded} 条`,
            `  冷数据: ${stats.coldEntries}`,
            categoryLines ? `  分类:\n${categoryLines}` : '  (空)',
          ].join('\n'),
          'info',
        )
        return
      }

      // ── summary ──
      if (subcmd === 'summary') {
        const n = parseInt(parts[1] ?? '', 10)
        const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 10
        const summaries = loadSummaries().slice(-limit).reverse()
        if (!summaries.length) {
          ctx.ui.notify('(暂无会话摘要)', 'info')
          return
        }
        const lines = summaries.map(
          (s, i) =>
            `${i + 1}. ${s.ts.slice(0, 10)} 「${s.title}」` +
            (s.decisions.length ? `\n   决策: ${s.decisions.join('; ').slice(0, 100)}` : '') +
            (s.prefs.length ? `\n   偏好: ${s.prefs.join('; ').slice(0, 100)}` : ''),
        )
        ctx.ui.notify(`会话摘要时间线 (${summaries.length}):\n${lines.join('\n')}`, 'info')
        return
      }

      // ── prune ──
      if (subcmd === 'prune') {
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
        return
      }

      // ── cleanup（承接原 ctx-lite:cleanup / ctx-lite:forget） ──
      if (subcmd === 'cleanup') {
        const rest = parts.slice(1).join(' ')
        if (rest.includes('--all')) {
          const notes = loadNotes()
          const noteCount = Object.keys(notes).filter(k => !k.startsWith('__')).length
          const cpCount = existsSync(CHECKPOINTS_DIR)
            ? readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json')).length
            : 0
          const choice = await ctx.ui.confirm(
            '清除所有笔记和检查点？',
            `这将删除 ${noteCount} 条笔记和 ${cpCount} 个检查点。此操作不可撤销。`,
          )
          if (!choice) return
          if (existsSync(CHECKPOINTS_DIR)) rmSync(CHECKPOINTS_DIR, { recursive: true })
          saveNotes({})
          ctx.ui.notify(`已清除全部笔记数据 (${noteCount} 条笔记, ${cpCount} 个检查点)`, 'info')
          return
        }
        const keepMatch = rest.match(/--keep\s+(\d+)/)
        const keep = Math.min(Math.max(keepMatch ? parseInt(keepMatch[1], 10) : 10, 1), 100)
        const dryRun = rest.includes('--dry-run')

        loadNotes()

        const autoFiles = existsSync(CHECKPOINTS_DIR)
          ? readdirSync(CHECKPOINTS_DIR)
              .filter(f => f.startsWith('__compaction_'))
              .sort()
              .reverse()
          : []
        let removed = 0
        for (const f of autoFiles.slice(keep)) {
          if (!dryRun) rmSync(join(CHECKPOINTS_DIR, f))
          removed++
        }

        const notes = loadNotes()
        const noteCount = Object.keys(notes).filter(k => !k.startsWith('__')).length
        const totalKB = (getNotesSize(notes) / 1024).toFixed(1)
        const checkpoints = existsSync(CHECKPOINTS_DIR)
          ? readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'))
          : []

        ctx.ui.notify(
          [
            `${dryRun ? '[DRY-RUN] ' : ''}清理完成:`,
            `  Notes: ${noteCount} (${totalKB} KB)`,
            `  自动检查点保留: ${Math.min(autoFiles.length, keep)}, 将删除: ${removed}${dryRun ? ' (已跳过)' : ''}`,
            `  总检查点: ${checkpoints.length}`,
            `  数据目录: ${process.env.PI_MEMORY_DIR || '~/.pi/memory'}`,
          ].join('\n'),
          'info',
        )
        return
      }

      ctx.ui.notify(
        `未知子命令: ${subcmd}\n用法: /memory <search|stats|summary|prune|cleanup> [args...]`,
        'error',
      )
    },
  })
}
