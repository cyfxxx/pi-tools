import { loadNotes, saveNotes, updateNotes, getNotesSize } from '../storage.ts'

const MAX_NOTES_SIZE = 2048 * 1024

export function registerNotesTools(pi: { registerTool: (def: unknown) => void }): void {
  // ── ctx_note ──
  pi.registerTool({
    name: 'ctx_note',
    label: 'Store Note',
    description:
      '存储跨对话压缩存活的便笺（记录文件编辑/任务状态/用户决定/错误等状态）。value 为 null 时删除；key 追加 @ttl=<ISO 时间戳> 自动过期。',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: "便笺键（点号命名空间，如 'task.current'）。追加 '@ttl=ISO_TIMESTAMP' 自动过期。",
        },
        value: { type: 'string', description: '存储值。省略=读取；null=删除。' },
      },
    },
    async execute(_id: unknown, params: Record<string, unknown>) {
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

  // ── ctx_list ──
  pi.registerTool({
    name: 'ctx_list',
    label: 'List Notes',
    description: "列出已存便笺键及其大小。detail:true 显示值。",
    parameters: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: "Filter by key prefix (e.g. 'task')" },
        detail: { type: 'boolean', description: 'Show full values (default false)' },
      },
    },
    async execute(_id: unknown, params: Record<string, unknown>) {
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
}
