import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const HOME = process.env.HOME || "/root"
export const DATA_DIR = process.env.CTX_LITE_DIR || join(HOME, ".pi", "ctx-lite")
export const NOTES_FILE = join(DATA_DIR, "notes.json")
export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints")
export const MAX_NOTES_SIZE = 1024 * 1024

export function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(CHECKPOINTS_DIR)) mkdirSync(CHECKPOINTS_DIR, { recursive: true })
}

export function loadNotes(): Record<string, string> {
  ensureDir()
  try {
    const raw: Record<string, string> = JSON.parse(readFileSync(NOTES_FILE, "utf-8"))
    const now = Date.now()
    let changed = false
    for (const key of Object.keys(raw)) {
      const ttlKey = `__ttl_${key}`
      const ttl = raw[ttlKey]
      if (ttl && new Date(ttl).getTime() <= now) {
        delete raw[key]
        delete raw[ttlKey]
        changed = true
      }
    }
    if (changed) saveNotes(raw)
    return raw
  } catch {
    return {}
  }
}

export function saveNotes(notes: Record<string, string>) {
  ensureDir()
  writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2))
}

export function clearCompactionFlag() {
  const notes = loadNotes()
  if (notes["_ctx.just_compacted"]) {
    delete notes["_ctx.just_compacted"]
    delete notes["_ctx.compacted_at"]
    saveNotes(notes)
  }
}

export function getTotalSize(notes: Record<string, string>): number {
  return Object.entries(notes)
    .filter(([k]) => !k.startsWith("__"))
    .reduce((sum, [, v]) => sum + Buffer.byteLength(v, "utf-8"), 0)
}
