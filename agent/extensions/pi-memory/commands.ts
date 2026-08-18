import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { MemoryCategory, MemoryEntry } from './types.ts'
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
import { ENVIRONMENTS, formatEnvironments, type RuntimeEnv } from './env.ts'

const CATEGORY_HINT =
  '类别: fact|preference|habit|procedure|reference'

const MEMORY_USAGE = [
  '/memory search <关键词> [--category=类别] [--limit=N]  搜索记忆库',
  '/memory stats                                        记忆库统计',
  '/memory summary [N]                                  最近 N 条会话摘要时间线',
  '/memory prune                                        清理低价值记忆（需确认）',
  '/memory cleanup [--keep=N] [--dry-run]                清理过期笔记/检查点，--all 清空',
  '/memory help                                         显示本帮助',
].join('\n')

export function registerCommands(pi: ExtensionAPI): void {
  // ── /memory（统一命令，子命令: search|stats|summary|prune|cleanup|help） ──
  pi.registerCommand('memory', {
    description:
      '持久记忆：搜索/统计/清理（/memory help 查看用法）',
    getArgumentCompletions: () => [
      { value: 'search', label: 'search', description: '搜索记忆（关键词 + 过滤）' },
      { value: 'stats', label: 'stats', description: '记忆库统计' },
      { value: 'summary', label: 'summary', description: '会话摘要时间线' },
      { value: 'prune', label: 'prune', description: '清理低价值记忆' },
      { value: 'cleanup', label: 'cleanup', description: '清理过期笔记/检查点' },
      { value: 'help', label: 'help', description: '显示用法' },
    ],
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/)
      const subcmd = parts[0]?.toLowerCase() || 'search'

      // ── help ──
      if (subcmd === 'help' || subcmd === '-h' || subcmd === '--help') {
        ctx.ui.notify(MEMORY_USAGE, 'info')
        return
      }

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
        let env: RuntimeEnv | 'all' | undefined
        for (const p of parts.slice(1)) {
          if (p.startsWith('--env=')) {
            const v = p.slice('--env='.length) as RuntimeEnv | 'all'
            if (ENVIRONMENTS.includes(v)) {
              env = v
            } else {
              ctx.ui.notify(`无效环境值: ${v}（可选: ${ENVIRONMENTS.join('/')}）`, 'error')
              return
            }
          }
        }
        const results = searchEntries(entries, queryParts.join(' '), category, undefined, limit, env)
        if (!results.length) {
          ctx.ui.notify('(无匹配的记忆)', 'info')
          return
        }
        const lines = results.map((e, i) => {
          const age = Math.round(
            (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24),
          )
          return `${i + 1}. [${e.category}] ${e.title}（${formatEnvironments(e.environments)}）(${e.confidence}, ${age}d)`
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
        // 审计 LOW：slice(-limit) 按插入序（pending 延迟提取乱序 append 会取到
        // 非最近摘要）——与 tools.ts memory_recall 对齐，按 ts 倒序取前 limit 条
        const summaries = [...loadSummaries()].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit)
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
        let entries: MemoryEntry[]
        try {
          entries = loadEntries()
        } catch (e) {
          ctx.ui.notify(`读取记忆库失败: ${(e as Error).message}`, 'error')
          return
        }
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
        if (!choice) {
          ctx.ui.notify('已取消清理（未删除任何条目）', 'info')
          return
        }
        let result: { removed: number; titles: string[] }
        try {
          result = pruneEntries(entries)
        } catch (e) {
          ctx.ui.notify(`清理失败: ${(e as Error).message}`, 'error')
          return
        }
        if (result.removed === 0) {
          ctx.ui.notify('没有符合清理条件的低价值记忆（置信度/引用/访问时间均达标）', 'info')
          return
        }
        // 具体删除清单（标题列表，过长截断前 20 条）
        const MAX_SHOW = 20
        const list = result.titles.slice(0, MAX_SHOW).map(t => `  - ${t}`).join('\n')
        const more = result.titles.length > MAX_SHOW ? `\n  …等共 ${result.titles.length} 条` : ''
        ctx.ui.notify(`清理完成，删除了 ${result.removed} 条低价值记忆：\n${list}${more}`, 'info')
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
          if (!choice) {
            ctx.ui.notify('已取消清除（未删除任何数据）', 'info')
            return
          }
          if (existsSync(CHECKPOINTS_DIR)) rmSync(CHECKPOINTS_DIR, { recursive: true })
          saveNotes({})
          ctx.ui.notify(`已清除全部笔记数据 (${noteCount} 条笔记, ${cpCount} 个检查点)`, 'info')
          return
        }
        const keepMatch = rest.match(/--keep[=\s]+(\d+)/)
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

      ctx.ui.notify(`未知子命令: ${subcmd}\n\n${MEMORY_USAGE}`, 'error')
    },
  })
}
