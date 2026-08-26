import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  MemoryEntry,
  MemoryStore,
  MemoryCategory,
  MemoryStats,
  SummaryEntry,
  SummaryStore,
  MemoryAction,
} from './types.ts'

const HOME = process.env.HOME || '/root'
export const DATA_DIR = process.env.PI_MEMORY_DIR || join(HOME, '.pi', 'memory')
export const ENTRIES_FILE = join(DATA_DIR, 'entries.json')
export const NOTES_FILE = join(DATA_DIR, 'notes.json')
export const SUMMARIES_FILE = join(DATA_DIR, 'summaries.json')
export const CHECKPOINTS_DIR = join(DATA_DIR, 'checkpoints')
export const STORE_VERSION = 2
export const SUMMARY_VERSION = 1
const PRUNE_CONFIDENCE = 0.3
const PRUNE_DAYS = 30
const PRUNE_RECURRENCE = 2
const PRUNE_DAYS_LOW = 60
const MAX_SUMMARIES = 50

// ctx-lite 旧位置（合并迁移）
const CTX_LITE_DIR = process.env.CTX_LITE_DIR || join(HOME, '.pi', 'ctx-lite')
const CTX_LITE_NOTES = join(CTX_LITE_DIR, 'notes.json')
const CTX_LITE_CHECKPOINTS = join(CTX_LITE_DIR, 'checkpoints')

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// 审计 HIGH 修复（2026-08-25）：summaries/notes 与 entries 对齐同一防护——
// 解析失败＝损坏面：先备份原文件到 .corrupt-<ts>（保留人工恢复机会、不被后续
// 全量覆盖清空）＋显式告警；文件不存在＝首次/重建正常路径返 null。
function readStoreFile<T>(file: string, kind: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch (err) {
    if (!existsSync(file)) return null
    // 审计 LOW：此前任意读异常（EACCES/EISDIR）都当损坏走 rename 备份分支，
    // 权限类错误被误判且会把目录 rename 成 .corrupt-*——仅语法错误才备份告警
    const isParseError = err instanceof SyntaxError
    if (!isParseError) {
      console.error(`[pi-memory] ${kind} 读取失败（非解析错误，不备份）:`, err instanceof Error ? err.message : err)
      return null
    }
    backupCorruptFile(file, kind)
    return null
  }
}

// 健壮读取 entries 存储：区分「文件不存在」（首次/重建，正常返回 null）与
// 「解析失败」（git 冲突标记/半截 checkout/损坏）——后者是 HIGH 数据丢失面：
// 原实现静默返回 []，且 saveEntries 读盘合并同样得 [] 后 writeJSONAtomic 全量覆盖，
// 全库记忆在无感知下被清空。修复：解析失败先备份原文件到 .corrupt-<ts>（保留
// 可人工恢复，不被后续覆盖）+ 显式告警，绝不静默。
function readEntriesFile(): MemoryStore | null {
  return readStoreFile<MemoryStore>(ENTRIES_FILE, 'entries')
}

function backupCorruptFile(file: string, kind: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.corrupt-${stamp}`
    renameSync(file, backup)
    console.error(`[pi-memory] ${kind} 存储损坏或含 git 冲突标记（${file}）：已备份到 ${backup} 避免覆盖丢失，请人工检查恢复后再移除该备份。`)
  } catch (e) {
    console.error(`[pi-memory] ${kind} 存储损坏（${file}）且自动备份失败，原文件保持原位：`, e)
  }
}

export function writeJSONAtomic(file: string, data: unknown) {
  ensureDir()
  // pid 后缀：主进程与提取子进程并发写同文件时互不踩踏 tmp 文件
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

// ── 敏感信息脱敏（写时净化）──────────────────────────────────
// 所有落盘文本（entries/summaries/notes）统一过 scrubSecrets，
// 防止密钥形态（GitHub PAT/API key/JWT 等）进入持久存储。
// 设计：形态匹配保守（长后缀+前缀限定），避免误伤 UUID 等正常文本；
// 替换为占位符而非拒绝写入，保证记忆流程不中断。
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // GitHub token（ghp_ 个人 / gho_ OAuth / ghu_ 用户级 / ghs_ 服务器 / ghr_ 刷新 / github_pat_ 精细）
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  // OpenAI/DeepSeek 风格 API key（允许中缀连字符/下划线，如 sk-proj-xxx）
  [/\bsk-[A-Za-z0-9_-]{15,}\b/g, '[REDACTED:api-key]'],
  // AWS Access Key ID
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  // JWT（eyJ 开头三段点分隔）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  // Authorization Bearer 头
  [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, '[REDACTED:bearer-token]'],
  // PEM 私钥/证书块（RSA/EC/OpenSSH/DSA/加密私钥），可跨行；防对话中粘贴私钥原文入库（审计 MEDIUM）
  [/\b-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----\b/g, '[REDACTED:private-key]'],
  // 密码/令牌键值形态: password/secret/api_key/token/access_key = 或 :（保守长值防误伤）
  [/\b(password|passwd|secret|api[_-]?key|token|access[_-]?key)\s*[=:]\s*['\"]?[^\s'\",;\x5b]{8,}/gi, '$1=[REDACTED]'],
  // JSON 序列化形态（审计 MEDIUM）："api_key": "长值"——键后引号致上一条 [=:] 紧邻要求漏检；保留引号结构。
  // 负向前瞻跳过已脱敏值（前缀规则先行时避免二次改写丢失具体类别标记）
  [/("(?:password|passwd|secret|api[_-]?key|token|access[_-]?key)"\s*:\s*")(?!\[REDACTED)([^"]{8,})(")/gi, '$1[REDACTED]$3'],
  // Google API key（审计 LOW：AIza 前缀定长 35）
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  // Slack token（审计 LOW：xox[baprs]- 前缀）
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED:slack-token]'],
  // 注：AWS secret access key 无前缀特征（40 位裸串），裸拦误伤面大，靠上方键值/JSON 形态规则覆盖
]

export function scrubSecrets(text: string): string {
  let out = text
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return out
}

function sanitizeEntry(e: MemoryEntry): MemoryEntry {
  return {
    ...e,
    title: scrubSecrets(e.title),
    content: scrubSecrets(e.content),
    // 历史条目可能缺 tags（旧版本数据）——防御，勿直接 .map
    tags: (e.tags ?? []).map(t => scrubSecrets(t)),
  }
}

function sanitizeSummary(s: SummaryEntry): SummaryEntry {
  return {
    ...s,
    title: scrubSecrets(s.title),
    fullText: scrubSecrets(s.fullText),
    decisions: s.decisions.map(x => scrubSecrets(x)),
    facts: s.facts.map(x => scrubSecrets(x)),
    prefs: s.prefs.map(x => scrubSecrets(x)),
    lessons: s.lessons.map(x => scrubSecrets(x)),
  }
}

// ── L1 长期记忆 ──────────────────────────────────────────────

export function loadEntries(): MemoryEntry[] {
  ensureDir()
  const store = readEntriesFile()
  if (!store || !Array.isArray(store.entries)) return []
  // 审计 MEDIUM（2026-08-25）：scrubSecrets 仅写路径生效，旧版本或手工编辑的条目
  // 可能未经脱敏——读时统一重洗（幂等，对已脱敏文本无害），防密钥经注入进入上下文
  return store.entries.map(migrateEntry).map(sanitizeEntry)
}

// v1 → v2：补充 observedAt；兼容旧 source 取值
function migrateEntry(e: MemoryEntry): MemoryEntry {
  if (!e.observedAt) e.observedAt = e.createdAt
  if (!e.id) e.id = randomUUID()
  if (typeof e.deleted !== 'boolean') e.deleted = false
  // 审计 LOW 修复：accessedAt 缺失/非法（NaN 天龄）会使剪枝条件恒 false、
  // qualityScore 排序失效——归一化为 observedAt，仍非法则当前时间
  if (!e.accessedAt || Number.isNaN(new Date(e.accessedAt).getTime())) {
    e.accessedAt = (e.observedAt && !Number.isNaN(new Date(e.observedAt).getTime())) ? e.observedAt : new Date().toISOString()
  }
  return e
}

export function saveEntries(entries: MemoryEntry[], opts: { excludeIds?: Set<string> } = {}): MemoryEntry[] {
  // 写前重读合并（审计 MEDIUM）：提取子进程（LLM 分钟级）写回前主进程可能已写入
  // 新条目，全量覆盖会丢更新——重读磁盘按 id 合并（传入快照优先），补上并发新增
  let merged = entries
  try {
    const onDisk = readEntriesRaw()
    if (onDisk.length > 0) {
      const byId = new Map(entries.map(e => [e.id, e]))
      for (const d of onDisk) {
        // 只补并发新增（磁盘活跃、快照没有）；deleted 条目不补（保留回收语义）；
        // 传入快照优先覆盖同 id；excludeIds（真移除的墓碑）不补——防删除被复活
        if (d.id && !byId.has(d.id) && !d.deleted && !opts.excludeIds?.has(d.id)) byId.set(d.id, d)
      }
      merged = [...byId.values()]
    }
  } catch {
    /* 读失败（文件不存在/损坏）用传入快照 */
  }
  writeJSONAtomic(ENTRIES_FILE, { version: STORE_VERSION, entries: merged.map(sanitizeEntry) } satisfies MemoryStore)
  // LOW 修复：返回合并后数组（含磁盘并发新增），调用方吸收避免内存态与磁盘脱节
  return merged
}

function readEntriesRaw(): MemoryEntry[] {
  ensureDir()
  const store = readEntriesFile()
  if (!store || !Array.isArray(store.entries)) return []
  return store.entries
}

export function activeEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter(e => !e.deleted && !e.supersededBy)
}

// ── L2 会话摘要 ──────────────────────────────────────────────

export function loadSummaries(): SummaryEntry[] {
  ensureDir()
  const store = readStoreFile<SummaryStore>(SUMMARIES_FILE, 'summaries')
  if (!store || !Array.isArray(store.summaries)) return []
  // 审计 MEDIUM：读时重洗 scrubSecrets（对齐 loadEntries）——旧版本/手工编辑的 summaries
  // 中密钥不经写时净化即可存在，注入块直接消费本函数返回值
  return store.summaries.map(sanitizeSummary)
}

export function saveSummaries(summaries: SummaryEntry[]) {
  writeJSONAtomic(SUMMARIES_FILE, { version: SUMMARY_VERSION, summaries } satisfies SummaryStore)
}

/**
 * 追加/更新摘要：同 sessionId 只保留最新一条（upsert）。
 * 审计发现：compact+shutdown 双路径提取时 messageCount 不同绕过指纹去重，
 * 同一会话重复 append 致 summaries.json 累积 31 条重复（实测）；注入侧因此
 * 重复展示同一会话的多条历史摘要。upsert 后同会话永远只有最新摘要。
 */
export function appendSummary(summary: SummaryEntry): SummaryEntry[] {
  const all = loadSummaries()
  const clean = sanitizeSummary(summary)
  const existing = clean.sessionId ? all.findIndex(s => s.sessionId === clean.sessionId) : -1
  if (existing >= 0) {
    all[existing] = clean
  } else {
    all.push(clean)
  }
  let trimmed = all.length > MAX_SUMMARIES ? all.slice(-MAX_SUMMARIES) : all
  // 审计 MEDIUM 修复：写前重读磁盘，按 sessionId 吸收并发新增（同机多实例同时
  // append 时 last-writer-wins 会丢对方条目；同 sessionId 冲突以本次写入优先），
  // 对齐 saveEntries 的写前合并策略
  try {
    // 用健壮读：磁盘文件若已损坏，先备份再放弃吸收（内存态照常落盘，原数据可从 .corrupt-* 恢复）
    const fresh = readStoreFile<SummaryStore>(SUMMARIES_FILE, 'summaries')
    if (fresh && Array.isArray(fresh.summaries)) {
      const seen = new Set(trimmed.map(s => s.sessionId))
      for (const d of fresh.summaries) {
        if (d?.sessionId && !seen.has(d.sessionId)) trimmed.push(d)
      }
    }
  } catch { /* 读失败用内存态 */ }
  if (trimmed.length > MAX_SUMMARIES) trimmed = trimmed.slice(-MAX_SUMMARIES)
  saveSummaries(trimmed)
  return trimmed
}

// ── L0 工作笔记（ctx-lite 合并） ─────────────────────────────

// 原始读：不做 TTL 清理不落盘（updateNotes/loadNotes 共用基座）
function rawLoadNotes(): Record<string, string> {
  migrateFromCtxLite()
  return readStoreFile<Record<string, string>>(NOTES_FILE, 'notes') || {}
}

// 原始写：脱敏后原子落盘（key 同样过 scrubSecrets——审计 LOW：密钥形态字符串作 note key 时绕过净化）
function rawSaveNotes(notes: Record<string, string>) {
  const scrubbed: Record<string, string> = {}
  for (const [k, v] of Object.entries(notes)) {
    const cleanKey = k.startsWith('__ttl_') ? k : scrubSecrets(k)
    scrubbed[cleanKey] = k.startsWith('__ttl_') ? v : scrubSecrets(v)
  }
  writeJSONAtomic(NOTES_FILE, scrubbed)
}

/**
 * 审计 MEDIUM：notes 原子更新基座——fresh 读 → 调用方原地改（增删改均可）→ 落盘。
 * 替代 load→mutate→save 三段式：三段式的中间窗口内他实例写入会被本次整档覆盖丢更新
 * （提取子进程 TTL 清理 vs 主进程 session_compact 写 _ctx.compacted_at 实测互踩场景）。
 * 与 appendSummary 的写前吸收同级属 best-effort：未消除同 key 并发 last-writer-wins，
 * 但不同 key 不再互踩，且删除语义天然保留。
 */
export function updateNotes<T>(fn: (notes: Record<string, string>) => T): T {
  const notes = rawLoadNotes()
  const result = fn(notes)
  rawSaveNotes(notes)
  return result
}

export function loadNotes(): Record<string, string> {
  ensureDir()
  const notes = rawLoadNotes()
  // TTL 惰性清理：仅过滤内存视图不落盘（读路径写是互踩源之一）；磁盘残留过期键
  // 由下一次任意 updateNotes 落盘自然清除，读取侧始终过滤无副作用
  const now = Date.now()
  for (const key of Object.keys(notes)) {
    const ttlKey = `__ttl_${key}`
    const ttl = notes[ttlKey]
    if (ttl && new Date(ttl).getTime() <= now) {
      delete notes[key]
      delete notes[ttlKey]
    }
  }
  return notes
}

export function saveNotes(notes: Record<string, string>) {
  // 全量替换意图（清空/恢复检查点等显式调用方）：不走吸收合并，保持覆盖语义
  rawSaveNotes(notes)
}

// ctx-lite 数据首次迁移：notes.json + checkpoints 复制到新目录
let ctxLiteMigrated = false
export function migrateFromCtxLite(): void {
  if (ctxLiteMigrated) return
  ctxLiteMigrated = true
  try {
    if (!existsSync(NOTES_FILE) && existsSync(CTX_LITE_NOTES)) {
      ensureDir()
      const raw = readFileSync(CTX_LITE_NOTES, 'utf-8')
      writeJSONAtomic(NOTES_FILE, JSON.parse(raw))
    }
    if (!existsSync(CHECKPOINTS_DIR) && existsSync(CTX_LITE_CHECKPOINTS)) {
      ensureDir()
      cpSync(CTX_LITE_CHECKPOINTS, CHECKPOINTS_DIR, { recursive: true })
    }
  } catch { /* 迁移失败不阻塞 */ }
}

export function clearCompactionFlag() {
  updateNotes(notes => {
    if (notes['_ctx.just_compacted']) {
      delete notes['_ctx.just_compacted']
      delete notes['_ctx.compacted_at']
    }
  })
}

export function getTotalSize(entries: MemoryEntry[]): number {
  return entries.reduce(
    (sum, e) => sum + Buffer.byteLength(e.title + e.content, 'utf-8'),
    0,
  )
}

export function getNotesSize(notes: Record<string, string>): number {
  return Object.entries(notes)
    .filter(([k]) => !k.startsWith('__') && !k.startsWith('_ctx.'))
    .reduce((sum, [, v]) => sum + Buffer.byteLength(v, 'utf-8'), 0)
}

// ── 写入与消解 ───────────────────────────────────────────────

export function storeEntry(
  entries: MemoryEntry[],
  entry: MemoryEntry,
): { entries: MemoryEntry[]; action: 'created' | 'merged' | 'updated' } {
  const live = activeEntries(entries)

  const titleMatch = live.findIndex(
    e => e.title.toLowerCase() === entry.title.toLowerCase(),
  )
  if (titleMatch !== -1) {
    const e = live[titleMatch]
    e.content = entry.content
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.environments = mergeEnvironments(e.environments, entry.environments)
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    e.accessedAt = entry.accessedAt
    if (entry.lastSessionId) e.lastSessionId = entry.lastSessionId
    const merged = saveEntries(entries)
    return { entries: merged, action: 'updated' }
  }

  const contentTokens = tokenize(entry.content)
  const mergeIdx = live.findIndex(e => {
    const existingTokens = tokenize(e.content)
    return jaccardSimilarity(contentTokens, existingTokens) > 0.7
  })
  if (mergeIdx !== -1) {
    const e = live[mergeIdx]
    if (contentTokens.length > tokenize(e.content).length) {
      e.content = entry.content
    }
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.environments = mergeEnvironments(e.environments, entry.environments)
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    e.accessedAt = entry.accessedAt
    if (entry.lastSessionId) e.lastSessionId = entry.lastSessionId
    const merged = saveEntries(entries)
    return { entries: merged, action: 'merged' }
  }

  entries.push(entry)
  const merged2 = saveEntries(entries)
  return { entries: merged2, action: 'created' }
}

// Mem0 式四操作应用（决策由 merge.ts 生成）
export function applyMem0Action(
  entries: MemoryEntry[],
  action: MemoryAction,
  candidate: MemoryEntry,
  targetId?: string,
): { entries: MemoryEntry[]; applied: boolean } {
  switch (action) {
    case 'ADD': {
      entries.push(candidate)
      const merged = saveEntries(entries)
      return { entries: merged, applied: true }
    }
    case 'UPDATE': {
      const idx = entries.findIndex(e => e.id === targetId)
      if (idx === -1) return { entries, applied: false }
      const e = entries[idx]
      e.content = candidate.content
      e.tags = [...new Set([...e.tags, ...candidate.tags])]
      e.confidence = Math.max(e.confidence, candidate.confidence)
      e.recurrence += 1
      e.updatedAt = candidate.updatedAt
      e.accessedAt = candidate.accessedAt
      if (candidate.observedAt) e.observedAt = candidate.observedAt
      // 与手动路径（storeEntry）一致：合并环境并集，跨环境提取不丢标签
      e.environments = mergeEnvironments(e.environments, candidate.environments)
      const merged = saveEntries(entries)
      return { entries: merged, applied: true }
    }
    case 'DELETE': {
      const idx = entries.findIndex(e => e.id === targetId)
      if (idx === -1) return { entries, applied: false }
      entries[idx].deleted = true
      entries[idx].updatedAt = new Date().toISOString()
      const merged = saveEntries(entries)
      return { entries: merged, applied: true }
    }
    case 'NOOP':
      return { entries, applied: false }
  }
}

export function deleteEntry(entries: MemoryEntry[], id: string): boolean {
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  // 墓碑：写前合并（saveEntries）不得把刚删除的条目从磁盘复活
  saveEntries(entries, { excludeIds: new Set([id]) })
  return true
}

export function pruneEntries(entries: MemoryEntry[]): { removed: number; titles: string[] } {
  const now = Date.now()
  const before = entries.length
  const removedTitles: string[] = []
  const kept = entries.filter(e => {
    // 软删除/被取代条目直接回收（保留 superseded 统计用则仅回收 deleted）
    if (e.deleted) return false
    // 防御：调用方可能传入未过 migrate 的条目，NaN 天龄视为最近访问（不剪枝）
    const ts = new Date(e.accessedAt).getTime()
    const age = Number.isNaN(ts) ? 0 : now - ts
    const daysOld = age / (1000 * 60 * 60 * 24)
    if (e.confidence < PRUNE_CONFIDENCE && daysOld > PRUNE_DAYS) return false
    if (e.recurrence < PRUNE_RECURRENCE && daysOld > PRUNE_DAYS_LOW) return false
    return true
  })
  const keptSet = new Set(kept)
  const prunedIds = new Set<string>()
  if (kept.length < before) {
    for (const e of entries) {
      if (!keptSet.has(e)) {
        removedTitles.push(e.title)
        prunedIds.add(e.id)
      }
    }
  }
  const removed = before - kept.length
  entries.length = 0
  entries.push(...kept)
  // 审计修复：剪枝是真移除（非软删除），须传 excludeIds 墓碑，否则 saveEntries
  // 写前磁盘合并会把磁盘上仍活跃的剪枝条目补回复活（对照 deleteEntry 的正确传法）
  saveEntries(entries, { excludeIds: prunedIds })
  return { removed, titles: removedTitles }
}

/**
 * 自动回收（审计发现）：pruneEntries 仅由用户 /memory prune 触发，而提取持续 ADD
 * 且 deleted/superseded 条目不回收 → entries.json 无界增长。before_agent_start 每轮
 * 全量读盘时若条目数超阈值（默认 600）自动回收 deleted 软删条目（无风险子集，
 * 不碰时效剪枝——那部分语义保留给用户显式 prune）。返回回收后条目（未触发返回 null）。
 */
export function autoReclaim(entries: MemoryEntry[], softLimit = 600): MemoryEntry[] | null {
  if (entries.length <= softLimit) return null
  const kept = entries.filter(e => !e.deleted)
  if (kept.length === entries.length) return null
  saveEntries(kept)
  return kept
}

export function getStats(entries: MemoryEntry[]): MemoryStats {
  const now = Date.now()
  const byCategory: Record<string, number> = {}
  let oldest: string | null = null
  let newest: string | null = null
  let cold = 0
  let superseded = 0

  for (const e of entries) {
    if (e.deleted) continue
    if (e.supersededBy) {
      superseded++
      continue
    }
    byCategory[e.category] = (byCategory[e.category] || 0) + 1

    if (!oldest || e.createdAt < oldest) oldest = e.createdAt
    if (!newest || e.createdAt > newest) newest = e.createdAt

    const ts = new Date(e.accessedAt).getTime()
    const age = Number.isNaN(ts) ? 0 : now - ts
    if (age / (1000 * 60 * 60 * 24) > PRUNE_DAYS) cold++
  }

  return {
    totalEntries: entries.length,
    activeEntries: activeEntries(entries).length,
    byCategory,
    totalSizeBytes: getTotalSize(entries),
    oldestEntry: oldest,
    newestEntry: newest,
    coldEntries: cold,
    summaries: loadSummaries().length,
    superseded,
  }
}

// ── 词法工具 ─────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase()
    .split(/[\s,，。.、：:;；!！?？()（）\[\]【】{}""''\/\\\-_+#@$%^&*=|~`]+/)
    .filter(t => t.length > 0)
  // 中文补充 bigram，弥补无分词器时的检索盲区
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '')
  if (cjk.length >= 2) {
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk.slice(i, i + 2))
    }
  }
  return tokens
}

export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

/** 合并环境标签（title 匹配更新 / 内容合并时取并集；旧数据无 environments 视为 all）。 */
export function mergeEnvironments(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] {
  const base = existing && existing.length > 0 ? existing : ['all']
  const inc = incoming && incoming.length > 0 ? incoming : ['all']
  return [...new Set([...base, ...inc])]
}
