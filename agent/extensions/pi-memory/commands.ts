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
import { extractConversation, extractTextFromEntries } from './extract.ts'

const CATEGORY_HINT =
  '类别: fact|preference|habit|procedure|reference'

export function registerCommands(pi: ExtensionAPI): void {
  // ── /memory:search ──
  pi.registerCommand('memory:search', {
    description: '搜索持久记忆库。用法: /memory:search <关键词> [--category=<类别>] [--limit=N]',
    usage: '/memory:search <query> [--category=fact|preference|habit|procedure|reference] [--limit=N]',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      if (!parts.length || parts[0].startsWith('--')) {
        ctx.ui.notify(`用法: /memory:search <关键词> [--category=<类别>] [--limit=N]`, 'error')
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

      ctx.ui.notify(`记忆搜索结果 (${results.length}):\n${lines.join('\n')}`, 'info')
    },
  })

  // ── /memory:stats ──
  pi.registerCommand('memory:stats', {
    description: '显示记忆库统计信息：条目数、大小、各类别分布、冷数据比例、摘要数。',
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
          `  条目: ${stats.totalEntries}（活跃 ${stats.activeEntries}）`,
          `  大小: ${sizeMB} MB / 1 MB`,
          `  会话摘要: ${stats.summaries} 条`,
          `  被取代: ${stats.superseded} 条`,
          `  冷数据: ${stats.coldEntries}`,
          categoryLines ? `  分类:\n${categoryLines}` : '  (空)',
        ].join('\n'),
        'info',
      )
    },
  })

  // ── /memory:prune ──
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

  // ── /memory:digest（新增：手动触发会话提取） ──
  pi.registerCommand('memory:digest', {
    description:
      '手动触发当前会话记忆提取（LLM 分析会话 → 提取长期记忆 + 生成摘要）。' +
      '正常在 compaction/会话结束时自动执行。',
    usage: '/memory:digest',
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId() || null
      const branch = ctx.sessionManager.getBranch()
      const messages = extractTextFromEntries(branch as Array<{ role?: string; content?: unknown; message?: { role?: string; content?: unknown } }>)
      if (!messages.length) {
        ctx.ui.notify('会话中没有可提取的消息', 'info')
        return
      }
      ctx.ui.notify(`正在提取 ${messages.length} 条消息的记忆...`, 'info')
      const outcome = await extractConversation(messages, { sessionId, messageCount: messages.length })
      if (!outcome.ok) {
        ctx.ui.notify(`提取失败: ${outcome.error}`, 'error')
        return
      }
      ctx.ui.notify(
        `提取完成: 新增/更新 ${outcome.memories} 条记忆${outcome.skipped ? `，跳过 ${outcome.skipped} 条` : ''}${outcome.summary ? `，摘要「${outcome.summary.title}」` : ''}`,
        'info',
      )
    },
  })

  // ── /memory:summary（新增：查看会话摘要时间线） ──
  pi.registerCommand('memory:summary', {
    description: '查看历史会话摘要时间线（最近 10 条）。用法: /memory:summary [N]',
    usage: '/memory:summary [N]',
    handler: async (args, ctx) => {
      const n = parseInt(args.trim(), 10)
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
    },
  })

  // ── /ctx-lite:* 兼容别名 ──
  pi.registerCommand('ctx-lite:status', {
    description: '[兼容] 显示笔记/检查点状态（pi-memory 合并后）',
    usage: '/ctx-lite:status',
    handler: async (_args, ctx) => {
      const notes = loadNotes()
      const noteKeys = Object.keys(notes).filter(k => !k.startsWith('__'))
      const totalKB = (getNotesSize(notes) / 1024).toFixed(1)
      const checkpoints = existsSync(CHECKPOINTS_DIR)
        ? readdirSync(CHECKPOINTS_DIR).filter(f => f.endsWith('.json'))
        : []
      const autoCp = checkpoints.filter(f => f.startsWith('__compaction_')).length
      ctx.ui.notify(
        [
          'pi-memory (ctx-lite 合并)',
          `  Notes: ${noteKeys.length} (${totalKB} KB)`,
          `  Checkpoints: ${checkpoints.length} (auto: ${autoCp}, manual: ${checkpoints.length - autoCp})`,
          `  Data dir: ${process.env.PI_MEMORY_DIR || '~/.pi/memory'}`,
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('ctx-lite:cleanup', {
    description:
      '[兼容] 清理过期笔记和旧检查点。--keep <N> 保留最近 N 个自动检查点。--dry-run 仅预览不执行',
    usage: '/ctx-lite:cleanup [--keep=N] [--dry-run]',
    handler: async (args, ctx) => {
      const keepMatch = args.match(/--keep\s+(\d+)/)
      const keep = keepMatch ? parseInt(keepMatch[1], 10) : 10
      const dryRun = args.includes('--dry-run')

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
          `${dryRun ? '[DRY-RUN] ' : ''}Cleanup complete:`,
          `  Notes: ${noteCount} (${totalKB} KB)`,
          `  Auto-checkpoints kept: ${Math.min(autoFiles.length, keep)}, would remove: ${removed}${dryRun ? ' (skipped)' : ''}`,
          `  Total checkpoints: ${checkpoints.length}`,
        ].join('\n'),
        'info',
      )
    },
  })

  pi.registerCommand('ctx-lite:forget', {
    description: '[兼容] 删除所有笔记和检查点',
    usage: '/ctx-lite:forget',
    handler: async (_args, ctx) => {
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
      ctx.ui.notify(`Cleared all notes data (${noteCount} notes, ${cpCount} checkpoints)`, 'info')
    },
  })
}
