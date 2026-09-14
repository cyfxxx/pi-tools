import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadNotes, saveNotes, CHECKPOINTS_DIR } from '../storage.ts'

const MAX_CHECKPOINTS_LIST = 100

interface SnapData {
  timestamp: number
  notes: Record<string, string>
  compaction?: boolean
}

function sanitizeSnapName(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 80) return null
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null
  return trimmed
}

export function registerCheckpointTools(pi: { registerTool: (def: unknown) => void }): void {
  pi.registerTool({
    name: 'ctx_snap',
    label: 'Save Checkpoint',
    description:
      '保存当前便笺的命名检查点（含时间戳）。用 restore:<name> 恢复；list 查看全部。适合风险操作前或里程碑节点。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Checkpoint name (e.g. 'before-refactor'). Use 'restore:<name>' to restore. Use 'list' to list all.",
        },
      },
    },
    async execute(_id: unknown, params: Record<string, unknown>) {
      const name = params.name as string

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
