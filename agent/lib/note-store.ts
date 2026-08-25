import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, renameSync } from "node:fs"
import { join } from "node:path"
// 审计 MEDIUM 修复（2026-08-25）：脱敏复用 pi-memory 的 scrubSecrets（写时净化），
// 消除双实现漂移——此前 note-store.saveNotes 不脱敏，plan-mode 经此路径写入的
// 笔记可绕过密钥形态净化入库
import { scrubSecrets } from "../extensions/pi-memory/storage.ts"

const HOME = process.env.HOME || "/root"
// 审计 MEDIUM 修复（2026-08-25）：env 键与 pi-memory/storage 对齐——优先 PI_MEMORY_DIR，
// CTX_LITE_DIR 仅作历史兼容回退。原实现只认 CTX_LITE_DIR：单设其一即指向不同文件，
// 同一 notes.json 被两套读写分裂。
export const DATA_DIR = process.env.PI_MEMORY_DIR || process.env.CTX_LITE_DIR || join(HOME, ".pi", "memory")
export const NOTES_FILE = join(DATA_DIR, "notes.json")
export const CHECKPOINTS_DIR = join(DATA_DIR, "checkpoints")
export const MAX_NOTES_SIZE = 1024 * 1024

export function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(CHECKPOINTS_DIR)) mkdirSync(CHECKPOINTS_DIR, { recursive: true })
}

export function loadNotes(): Record<string, string> {
  ensureDir()
  let raw: Record<string, string>
  try {
    raw = JSON.parse(readFileSync(NOTES_FILE, "utf-8"))
  } catch {
    // 审计 HIGH 对齐修复（2026-08-25）：损坏不再静默返 {}——先备份 .corrupt-* 再空启动，
    // 防后续 saveNotes 全量覆盖清空真实数据；文件不存在属首次运行正常路径
    if (existsSync(NOTES_FILE)) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const backup = `${NOTES_FILE}.corrupt-${stamp}`
        renameSync(NOTES_FILE, backup)
        console.error(`[note-store] notes.json 损坏：已备份到 ${backup}，请人工检查恢复后再移除该备份。`)
      } catch (e) {
        console.error("[note-store] notes.json 损坏且自动备份失败，原文件保持原位：", e)
        return {}
      }
    }
    raw = {}
  }
  // TTL 清理
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
}

export function saveNotes(notes: Record<string, string>) {
  ensureDir()
  // 写时净化：值统一过 scrubSecrets（键不改写，避免破坏读回一致性）
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(notes)) {
    clean[k] = typeof v === "string" ? scrubSecrets(v) : v
  }
  const tmp = `${NOTES_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(clean, null, 2))
  renameSync(tmp, NOTES_FILE)
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
