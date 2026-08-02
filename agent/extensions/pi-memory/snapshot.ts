import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadNotes, saveNotes, CHECKPOINTS_DIR, getNotesSize } from './storage.ts'

const MAX_AUTO_CHECKPOINTS = 5

interface SnapData {
  timestamp: number
  notes: Record<string, string>
  compaction?: boolean
}

// compaction 前快照：notes + 压缩标记（ctx-lite 行为迁移）
export function writeCompactionSnapshot(ctx: { sessionManager?: unknown; hasUI?: boolean }): string | null {
  const notes = loadNotes()
  const userNotes = Object.keys(notes).filter(
    k => !k.startsWith('__') && !k.startsWith('_ctx.'),
  )
  if (userNotes.length === 0) return null

  if (!existsSync(CHECKPOINTS_DIR)) {
    mkdirSync(CHECKPOINTS_DIR, { recursive: true })
  }

  const snap: SnapData = { timestamp: Date.now(), notes, compaction: true }
  const file = join(CHECKPOINTS_DIR, `__compaction_${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(snap, null, 2))

  const files = readdirSync(CHECKPOINTS_DIR)
    .filter(f => f.startsWith('__compaction_'))
    .sort()
    .reverse()
  for (const f of files.slice(MAX_AUTO_CHECKPOINTS)) {
    rmSync(join(CHECKPOINTS_DIR, f))
  }
  return file
}
