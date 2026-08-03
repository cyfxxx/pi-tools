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
  getStats,
  getTotalSize,
  getNotesSize,
  loadNotes,
  saveNotes,
  loadSummaries,
  CHECKPOINTS_DIR,
} from './storage.ts'
import { searchEntries } from './retrieval.ts'

const MAX_CHECKPOINTS_LIST = 100
const MAX_NOTES_SIZE = 1024 * 1024

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

const CATEGORIES: MemoryCategory[] = ['fact', 'preference', 'habit', 'procedure', 'reference']

export function registerTools(pi: ExtensionAPI): void {
  // ── memory_store ──
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
          enum: CATEGORIES,
          description: '类别: fact=事实, preference=用户偏好, habit=用户习惯, procedure=操作流程, reference=参考信息',
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
      }

      const { action } = storeEntry(entries, entry)
      const totalSize = getTotalSize(entries)

      const actionMap: Record<string, string> = {
        created: '新存入',
        merged: '合并到已有条目',
        updated: '更新已有条目',
      }

      let msg = `已${actionMap[action]}记忆: "${entry.title}" (${entry.category})`
      if (totalSize > 900 * 1024) {
        msg += `\n警告: 记忆库 ${(totalSize / (1024 * 1024)).toFixed(1)} MB，接近 1 MB 上限，请考虑 /memory prune 清理`
      }

      return { content: [{ type: 'text', text: msg }] }
    },
  })

  // ── memory_search ──
  pi.registerTool({
    name: 'memory_search',
    label: '搜索记忆',
    description:
      '从持久记忆库中搜索已存储的知识。支持按关键词、类别、标签过滤。' +
      '结果按相关度排序（BM25 词法相关 + 置信度+时效性+引用频率）。' +
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
        content: [{ type: 'text', text: `记忆搜索结果 (${results.length} 条):\n${lines.join('\n')}` }],
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
        content: [
          {
            type: 'text',
            text: [
              `记忆库统计:`,
              `  总条目: ${stats.totalEntries}（活跃 ${stats.activeEntries}）`,
              `  存储大小: ${sizeMB} MB / 1 MB`,
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
          enum: CATEGORIES,
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
          content: [{ type: 'text', text: ok ? `已删除记忆 ${id}` : `未找到记忆 ${id}` }],
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
            { type: 'text', text: `已删除 ${removed} 条 ${category} 类别记忆（${olderThan} 之前）` },
          ],
        }
      }

      return {
        content: [
          { type: 'text', text: '请指定 id 参数，或同时指定 category 和 olderThan 参数' },
        ],
        isError: true,
      }
    },
  })

  // ── memory_recall（新增：BM25 检索 + 会话摘要时间线） ──
  pi.registerTool({
    name: 'memory_recall',
    label: '回忆记忆与摘要',
    description:
      '综合检索跨会话长期记忆与历史会话摘要。' +
      'query 匹配长期记忆条目（BM25 词法相关 + 质量分混合排序）；' +
      '附加 --summaries 时同时返回最近会话摘要时间线，用于跨会话上下文衔接。',
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
        const summaries = loadSummaries().slice(-5).reverse()
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

      return { content: [{ type: 'text', text: blocks.join('\n\n') }] }
    },
  })

  // ── ctx_exec（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_exec',
    label: 'Execute Code',
    description:
      'Execute code (JS/TS/Python/Shell) in a child process. Only stdout enters the context window. ' +
      'Use this instead of reading many files — write a script to aggregate data and print the result.',
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
        return { content: [{ type: 'text', text: `Error: ${error}` }], isError: true }
      }
      if (status !== 0) {
        return { content: [{ type: 'text', text: `Exit code ${status}\n${stderr || stdout}` }], isError: true }
      }
      let output = stdout || '(no output)'
      if (Number.isFinite(cap) && output.length > cap) {
        const ratio = Math.round((cap / output.length) * 100)
        output = `${output.slice(0, cap)}\n\n[truncated: ${output.length} chars → ${cap} chars (${ratio}%)]`
      }
      recordToolUsage('ctx_exec', estimateTokens(output))
      const pruned = pruneToolOutput(output, 'ctx_exec')
      recordOutput('ctx_exec', pruned.length)
      return { content: [{ type: 'text', text: pruned }], details: { stderr: stderr || undefined } }
    },
  })

  // ── ctx_note（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_note',
    label: 'Store Note',
    description:
      "Store a note that survives conversation compaction. Use this to remember " +
      "file edits, task status, user decisions, errors, or any state across compactions. " +
      "Set value to 'null' to delete. Append '@ttl=<ISO timestamp>' to key (e.g. 'task.status@ttl=2026-12-31T23:59:59Z') to auto-expire.",
    parameters: Type.Object({
      key: Type.String({
        description: "Note key (dot notation for namespacing, e.g. 'task.current'). Append '@ttl=ISO_TIMESTAMP' for auto-expire.",
      }),
      value: Type.Optional(Type.String({ description: "Value to store. Omit to read. Set to 'null' to delete." })),
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
        }
      }
      if (params.value === 'null' || params.value === null) {
        const hadKey = key in notes
        delete notes[key]
        const ttlKey = `__ttl_${key}`
        delete notes[ttlKey]
        saveNotes(notes)
        return {
          content: [{ type: 'text', text: hadKey ? `Deleted note "${key}"` : `(no note "${key}" to delete)` }],
        }
      }

      const value = params.value as string
      notes[key] = value
      const ttlKey = `__ttl_${key}`
      if (ttl) {
        notes[ttlKey] = ttl
      } else {
        delete notes[ttlKey]
      }
      saveNotes(notes)

      const totalSize = getNotesSize(notes)
      const valueKB = (value.length / 1024).toFixed(1)
      let msg = `Saved note "${key}" (${valueKB} KB)`
      if (totalSize > MAX_NOTES_SIZE) {
        const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
        msg += `\nWarning: total notes size ${sizeMB} MB exceeds 1 MB — consider cleaning up with /memory:cleanup`
      }
      if (ttl) msg += `\nExpires: ${ttl}`
      return { content: [{ type: 'text', text: msg }] }
    },
  })

  // ── ctx_list（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_list',
    label: 'List Notes',
    description: "List all stored note keys with their sizes. Use detail:true to show values.",
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
        return { content: [{ type: 'text', text: '(no notes)' }] }
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
      }
    },
  })

  // ── ctx_snap（ctx-lite 迁移） ──
  pi.registerTool({
    name: 'ctx_snap',
    label: 'Save Checkpoint',
    description:
      "Save a named checkpoint of current notes + timestamp. " +
      "Use 'restore:<name>' to restore. Use 'list' to see all checkpoints. " +
      'Useful before risky operations or at natural milestones.',
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
          return { content: [{ type: 'text', text: '(no checkpoints)' }] }
        }
        const files = readdirSync(CHECKPOINTS_DIR)
          .filter(f => f.endsWith('.json'))
          .sort()
          .reverse()
          .slice(0, MAX_CHECKPOINTS_LIST)
        if (files.length === 0) {
          return { content: [{ type: 'text', text: '(no checkpoints)' }] }
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
        }
      }

      if (name.startsWith('restore:')) {
        const snapName = sanitizeSnapName(name.slice(8))
        if (!snapName) {
          return { content: [{ type: 'text', text: `非法检查点名称: "${name.slice(8)}"` }], isError: true }
        }
        const snapFile = join(CHECKPOINTS_DIR, `${snapName}.json`)
        if (!existsSync(snapFile)) {
          return { content: [{ type: 'text', text: `No checkpoint "${snapName}" found` }], isError: true }
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
          }
        } catch (e: unknown) {
          return {
            content: [{ type: 'text', text: `Failed to restore: ${(e as Error).message}` }],
            isError: true,
          }
        }
      }

      const snapName = sanitizeSnapName(name)
      if (!snapName) {
        return { content: [{ type: 'text', text: `非法检查点名称: "${name}"（仅允许字母/数字/._-，且不含路径分隔符）` }], isError: true }
      }
      try {
        mkdirSync(CHECKPOINTS_DIR, { recursive: true })
      } catch (e: unknown) {
        return {
          content: [{ type: 'text', text: `无法创建检查点目录: ${(e as Error).message}` }],
          isError: true,
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
      }
    },
  })
}
