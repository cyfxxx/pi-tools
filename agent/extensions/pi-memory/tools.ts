import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { recordToolUsage, estimateTokens } from '../../lib/token-budget.ts'
import { recordOutput, pruneToolOutput } from '../../lib/prune.ts'
import type { MemoryEntry, MemoryCategory } from './types.ts'
import {
  loadEntries,
  storeEntry,
  deleteEntry,
  saveEntries,
  getStats,
  getTotalSize,
  getNotesSize,
  loadNotes,
  saveNotes,
  updateNotes,
  loadSummaries,
  CHECKPOINTS_DIR,
} from './storage.ts'
import { searchEntries } from './retrieval.ts'
import { detectEnvironment, ENVIRONMENTS, formatEnvironments, type RuntimeEnv } from './env.ts'

const MAX_CHECKPOINTS_LIST = 100
const MAX_NOTES_SIZE = 2048 * 1024

const LANGUAGES: Record<string, { cmd: string; args: string[] }> = {
  js: { cmd: process.argv[0], args: ['-e'] },
  ts: { cmd: process.argv[0], args: ['-e'] },
  python: { cmd: 'python3', args: ['-c'] },
  shell: { cmd: 'bash', args: ['-c'] },
}

interface SnapData {
  timestamp: number
  notes: Record<string, string>
  compaction?: boolean
}

function detectLanguage(code: string): string {
  const firstLine = code.trim().split('\n')[0] || ''
  if (/^#!/.test(firstLine)) {
    if (/\bpython/.test(firstLine)) return 'python'
    if (/\bbash\b/.test(firstLine) || /\bsh\b/.test(firstLine)) return 'shell'
    if (/\bnode\b/.test(firstLine)) return 'js'
  }
  return 'js'
}

async function execLanguageAsync(
  language: string,
  code: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; status: number | null; error?: string }> {
  const lang = LANGUAGES[language]
  if (!lang) {
    return {
      stdout: '',
      stderr: '',
      status: null,
      error: `Unsupported language: "${language}". Supported: ${Object.keys(LANGUAGES).join(', ')}`,
    }
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(
    () => timeoutController.abort(new Error(`Timeout after ${timeout}ms`)),
    timeout,
  )
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>(
      (resolve, reject) => {
        const proc = spawn(lang.cmd, [...lang.args, code], {
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: combinedSignal,
        })

        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

        proc.on('close', status => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status }))
        proc.on('error', err => reject(err))
      },
    )
    return result
  } catch (err: unknown) {
    return { stdout: '', stderr: '', status: null, error: (err as Error).message }
  } finally {
    clearTimeout(timeoutId)
  }
}

const CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'habit', 'procedure', 'reference', 'solutions']

export function registerTools(pi: ExtensionAPI): void {
  // ── memory_store ──
  pi.registerTool({
    name: 'memory_store',
    label: '存储知识',
    description:
      '存储知识到持久记忆库（发现新信息/偏好/项目约定/API 用法时调用）。自动去重：同标题更新、近似内容合并。存储后未来会话可检索。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: '类别: fact=事实, preference=偏好, habit=习惯, procedure=流程, reference=参考',
        },
        title: {
          type: 'string',
          description: '简短标题，作搜索索引。例: "用户偏好: 使用 Shell 管理系统"',
        },
        content: {
          type: 'string',
          description: '详细内容',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签数组，用于分类检索',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '置信度 0-1：直接观察到的事实填 1.0，推断的填 0.5-0.7',
        },
        environment: {
          type: 'string',
          enum: ENVIRONMENTS as unknown as string[],
          description: '适用运行环境（缺省 all=通用，所有环境可见）。环境专属知识显式指定',
        },
      },
      required: ['category', 'title', 'content'],
    },
    execute: async (_toolCallId, params) => {
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

  // ── memory_search ──
  pi.registerTool({
    name: 'memory_search',
    label: '搜索记忆',
    description:
      '从持久记忆库检索知识。支持关键词/类别/标签过滤，结果按相关度排序（BM25 + 置信度/时效/引用频率）。回忆知识/偏好/项目约定时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，匹配标题、标签和内容',
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
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
        env: {
          type: 'string',
          enum: ENVIRONMENTS as unknown as string[],
          description: '按运行环境过滤（缺省=当前环境+all；传 all 则不过滤）',
        },
        asOf: {
          type: 'string',
          description: 'ISO 时间点：返回在该时刻有效的记忆（回溯查询，含被后来取代的旧事实；缺省=当前态）',
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const entries = loadEntries()
      const currentEnv = detectEnvironment()
      const envFilter: RuntimeEnv | 'all' = params.env ? (params.env as RuntimeEnv) : currentEnv
      const results = searchEntries(
        entries,
        params.query as string | undefined,
        params.category as MemoryCategory | undefined,
        params.tags as string[] | undefined,
        typeof params.limit === 'number' ? (params.limit as number) : 5,
        envFilter,
        typeof params.asOf === 'string' ? (params.asOf as string) : undefined,
      )

      if (!results.length) {
        return { content: [{ type: 'text', text: '(无匹配的记忆)' }], details: null }
      }

      const lines = results.map((e, i) => {
        const age = Math.round(
          (Date.now() - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        )
        return `${i + 1}. [${e.category}] ${e.title}（${formatEnvironments(e.environments)}）
   置信度: ${e.confidence} | 引用: ${e.recurrence} 次 | ${age} 天前
   ${e.content.length > 200 ? e.content.slice(0, 200) + '...' : e.content}`
      })

      return {
        content: [{ type: 'text', text: `记忆搜索结果 (${results.length} 条):\n${lines.join('\n')}` }],
      details: null,
        }
    },
  })

  // ── memory_stats ──
  pi.registerTool({
    name: 'memory_stats',
    label: '记忆统计',
    description: '查看持久记忆库的统计信息：条目总数、各类别分布、存储大小、冷数据比例、摘要数。',
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
        id: {
          type: 'string',
          description: '要删除的记忆条目 ID（与 category+olderThan 互斥）',
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: '按类别批量删除（需同时指定 olderThan）',
        },
        olderThan: {
          type: 'string',
          description: 'ISO 日期，删除该日期之前创建且匹配 category 的记忆。格式: "2026-06-01"',
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
        // 批量删除同样落盘（loadEntries 每次从磁盘重读，不落盘则下次调用即复活）
        // 墓碑：写前合并（saveEntries）不得把刚批量删除的条目从磁盘复活
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

  // ── memory_recall（新增：BM25 检索 + 会话摘要时间线） ──
  pi.registerTool({
    name: 'memory_recall',
    label: '回忆记忆与摘要',
    description:
      '综合检索长期记忆与历史会话摘要。query 匹配记忆条目（BM25 + 质量分）；附带 --summaries 时同时返回最近会话摘要时间线，用于跨会话衔接。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词（可空：仅返回高质量记忆）',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: '记忆条数上限（默认 3）',
        },
        summaries: {
          type: 'boolean',
          description: '是否附带最近会话摘要（默认 false）',
        },
      },
    },
    execute: async (_toolCallId, params) => {
      const entries = loadEntries()
      const limit = typeof params.limit === 'number' ? (params.limit as number) : 3
      const results = searchEntries(
        entries,
        params.query as string | undefined,
        undefined,
        undefined,
        limit,
        detectEnvironment(), // 默认只召回当前环境 + all 的条目
      )

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
        // 审计 LOW：slice(-5) 按插入序（pending 延迟提取乱序 append 会取到非最近摘要）
        // ——与 inject.ts 对齐，按 ts 排序后取最近 5 条
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

  // ── ctx_exec（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_exec',
    label: 'Execute Code',
    description:
      '在子进程中执行代码（JS/TS/Python/Shell），仅 stdout 进入上下文。适合聚合处理多个文件后打印结果，代替逐个读文件。',
    parameters: Type.Object({
      code: Type.String({ description: 'Code to execute' }),
      language: Type.Optional(
        Type.String({
          description: "Language: 'js' (default), 'python', 'shell'. Auto-detected from shebang if omitted.",
        }),
      ),
      description: Type.Optional(Type.String({ description: 'Brief description of what this does' })),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in ms (default 30000)' })),
      max_output: Type.Optional(
        Type.Number({ description: 'Max output chars (default 2000). Use 0 for unlimited.' }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const maxOutput = params.max_output as number | undefined
      const cap = maxOutput === undefined ? 2000 : maxOutput === 0 ? Infinity : maxOutput
      const code = params.code as string
      const timeout = (params.timeout as number | undefined) ?? 30000
      const language = (params.language as string | undefined) || detectLanguage(code)
      const { stdout, stderr, status, error } = await execLanguageAsync(language, code, timeout, signal)
      if (error) {
        return { content: [{ type: 'text', text: `Error: ${error}` }], details: null, isError: true }
      }
      if (status !== 0) {
        return { content: [{ type: 'text', text: `Exit code ${status}\n${stderr || stdout}` }], details: null, isError: true }
      }
      let output = stdout || '(no output)'
      if (Number.isFinite(cap) && output.length > cap) {
        const ratio = Math.round((cap / output.length) * 100)
        output = `${output.slice(0, cap)}\n\n[truncated: ${output.length} chars → ${cap} chars (${ratio}%)]`
      }
      const pruned = pruneToolOutput(output, 'ctx_exec')
      // 审计 MEDIUM 修复（2026-08-25）：剪枝后记录——原在剪枝前用全文估算，大输出被
      // 截断后仍按全文计账；usedTotal 单调锁存下峰值虚高 → 压力档误升、误触 P2「立即 /compact」
      recordToolUsage('ctx_exec', estimateTokens(pruned))
      recordOutput('ctx_exec', pruned.length)
      return { content: [{ type: 'text', text: pruned }], details: { stderr: stderr || undefined } }
    },
  })

  // ── ctx_note（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_note',
    label: 'Store Note',
    description:
      '存储跨对话压缩存活的便笺（记录文件编辑/任务状态/用户决定/错误等状态）。value 为 null 时删除；key 追加 @ttl=<ISO 时间戳> 自动过期。',
    parameters: Type.Object({
      key: Type.String({
        description: "便笺键（点号命名空间，如 'task.current'）。追加 '@ttl=ISO_TIMESTAMP' 自动过期。",
      }),
      value: Type.Optional(Type.String({ description: '存储值。省略=读取；null=删除。' })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const notes = loadNotes()
      const rawKey = params.key as string
      let key = rawKey
      let ttl: string | undefined

      const ttlMatch = rawKey.match(/^(.*)@ttl=(.+)$/)
      if (ttlMatch) {
        key = ttlMatch[1]
        ttl = ttlMatch[2]
      }

      if (params.value === undefined) {
        return {
          content: [{ type: 'text', text: notes[key] !== undefined ? notes[key] : `(no note for "${key}")` }],
        details: null,
        }
      }
      if (params.value === 'null' || params.value === null) {
        let hadKey = false
        updateNotes(notes => {
          hadKey = key in notes
          delete notes[key]
          delete notes[`__ttl_${key}`]
        })
        return {
          content: [{ type: 'text', text: hadKey ? `Deleted note "${key}"` : `(no note "${key}" to delete)` }],
        details: null,
          }
      }

      const value = params.value as string
      const totalSize = updateNotes(notes => {
        notes[key] = value
        const ttlKey = `__ttl_${key}`
        if (ttl) {
          notes[ttlKey] = ttl
        } else {
          delete notes[ttlKey]
        }
        return getNotesSize(notes)
      })
      const valueKB = (value.length / 1024).toFixed(1)
      let msg = `Saved note "${key}" (${valueKB} KB)`
      if (totalSize > MAX_NOTES_SIZE) {
        const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
        msg += `\nWarning: total notes size ${sizeMB} MB exceeds 2 MB — consider cleaning up with /memory cleanup`
      }
      if (ttl) msg += `\nExpires: ${ttl}`
      return { content: [{ type: 'text', text: msg }], details: null }
    },
  })

  // ── ctx_list（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_list',
    label: 'List Notes',
    description: "列出已存便笺键及其大小。detail:true 显示值。",
    parameters: Type.Object({
      prefix: Type.Optional(Type.String({ description: "Filter by key prefix (e.g. 'task')" })),
      detail: Type.Optional(Type.Boolean({ description: 'Show full values (default false)' })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const notes = loadNotes()
      const allKeys = Object.keys(notes).filter(k => !k.startsWith('__'))
      const prefix = params.prefix as string | undefined
      const keys = prefix ? allKeys.filter(k => k.startsWith(prefix)) : allKeys
      if (keys.length === 0) {
        return { content: [{ type: 'text', text: '(no notes)' }], details: null }
      }
      const totalSize = getNotesSize(notes)
      const detail = params.detail === true
      const lines = keys.map(k => {
        const v = notes[k]
        const size = v ? (v.length / 1024).toFixed(1) : '0'
        const ttlKey = `__ttl_${k}`
        const ttl = notes[ttlKey]
        const ttlStr = ttl ? ` [expires: ${ttl}]` : ''
        if (detail) {
          const val = v ? (v.length > 200 ? v.slice(0, 200) + '...' : v) : ''
          return `  ${k}  (${size} KB)${ttlStr}\n    ${val.replace(/\n/g, '\n    ')}`
        }
        return `  ${k}  (${size} KB)${ttlStr}`
      })
      const totalMB = (totalSize / (1024 * 1024)).toFixed(2)
      return {
        content: [{ type: 'text', text: `Notes (${keys.length}):\n${lines.join('\n')}\nTotal: ${totalMB} MB` }],
      details: null,
        }
    },
  })

  // ── ctx_snap（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_snap',
    label: 'Save Checkpoint',
    description:
      '保存当前便笺的命名检查点（含时间戳）。用 restore:<name> 恢复；list 查看全部。适合风险操作前或里程碑节点。',
    parameters: Type.Object({
      name: Type.String({
        description: "Checkpoint name (e.g. 'before-refactor'). Use 'restore:<name>' to restore. Use 'list' to list all.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const name = params.name as string

      const sanitizeSnapName = (raw: string): string | null => {
        const trimmed = raw.trim()
        if (!trimmed || trimmed.length > 80) return null
        if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null
        if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null
        return trimmed
      }

      if (name === 'list') {
        if (!existsSync(CHECKPOINTS_DIR)) {
          return { content: [{ type: 'text', text: '(no checkpoints)' }], details: null }
        }
        const files = readdirSync(CHECKPOINTS_DIR)
          .filter(f => f.endsWith('.json'))
          .sort()
          .reverse()
          .slice(0, MAX_CHECKPOINTS_LIST)
        if (files.length === 0) {
          return { content: [{ type: 'text', text: '(no checkpoints)' }], details: null }
        }
        const lines = files.map(f => {
          const snapName = f.replace(/\.json$/, '')
          try {
            const data: SnapData = JSON.parse(readFileSync(join(CHECKPOINTS_DIR, f), 'utf-8'))
            const isAuto = data.compaction ? ' [auto]' : ''
            const time = new Date(data.timestamp).toISOString()
            const noteCount = Object.keys(data.notes || {}).length
            const size = statSync(join(CHECKPOINTS_DIR, f)).size
            return `  ${snapName}${isAuto}  (${noteCount} notes, ${(size / 1024).toFixed(1)} KB, ${time})`
          } catch {
            return `  ${snapName}  (corrupted)`
          }
        })
        return {
          content: [{ type: 'text', text: `Checkpoints (${files.length}):\n${lines.join('\n')}` }],
        details: null,
          }
      }

      if (name.startsWith('restore:')) {
        const snapName = sanitizeSnapName(name.slice(8))
        if (!snapName) {
          return { content: [{ type: 'text', text: `非法检查点名称: "${name.slice(8)}"` }], details: null, isError: true }
        }
        const snapFile = join(CHECKPOINTS_DIR, `${snapName}.json`)
        if (!existsSync(snapFile)) {
          return { content: [{ type: 'text', text: `No checkpoint "${snapName}" found` }], details: null, isError: true }
        }
        try {
          const data: SnapData = JSON.parse(readFileSync(snapFile, 'utf-8'))
          saveNotes(data.notes || {})
          return {
            content: [
              {
                type: 'text',
                text: `Restored checkpoint "${snapName}" (${Object.keys(data.notes || {}).length} notes, from ${new Date(data.timestamp).toISOString()})`,
              },
            ],
          details: null,
            }
        } catch (e: unknown) {
          return {
            content: [{ type: 'text', text: `Failed to restore: ${(e as Error).message}` }],
            isError: true,
        details: null,
          }
        }
      }

      const snapName = sanitizeSnapName(name)
      if (!snapName) {
        return { content: [{ type: 'text', text: `非法检查点名称: "${name}"（仅允许字母/数字/._-，且不含路径分隔符）` }], details: null, isError: true }
      }
      try {
        mkdirSync(CHECKPOINTS_DIR, { recursive: true })
      } catch (e: unknown) {
        return {
          content: [{ type: 'text', text: `无法创建检查点目录: ${(e as Error).message}` }],
          isError: true,
        details: null,
        }
      }
      const notes = loadNotes()
      const snap: SnapData = { timestamp: Date.now(), notes }
      writeFileSync(join(CHECKPOINTS_DIR, `${snapName}.json`), JSON.stringify(snap, null, 2))
      return {
        content: [
          {
            type: 'text',
            text: `Saved checkpoint "${name}" (${Object.keys(notes).length} notes, ${new Date(snap.timestamp).toISOString()})`,
          },
        ],
      details: null,
        }
    },
  })
}
