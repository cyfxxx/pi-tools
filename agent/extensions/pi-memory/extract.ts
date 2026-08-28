import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { MemoryCategory, MemoryEntry, SummaryEntry } from './types.ts'
import { loadEntries, saveEntries, appendSummary, tokenize, DATA_DIR, writeJSONAtomic, scrubSecrets } from './storage.ts'
import { mergeCandidates } from './merge.ts'
import { detectEnvironment } from './env.ts'

export interface ExtractMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 提取子进程守卫（HIGH-3）：spawn 的 `pi -p` 子进程 env 带 PI_MEMORY_EXTRACT=1，
 *  session_start 据此跳过 pending 队列消费，避免与父进程并发抢任务。 */
export function isExtractWorker(): boolean {
  return process.env.PI_MEMORY_EXTRACT === '1'
}

export interface CandidateMemory {
  category: MemoryCategory
  title: string
  content: string
  tags: string[]
  confidence: number
}

export interface ExtractResult {
  summary: {
    title: string
    decisions: string[]
    facts: string[]
    prefs: string[]
    lessons: string[]
    fullText: string
  }
  memories: CandidateMemory[]
}

export interface ExtractOutcome {
  ok: boolean
  error?: string
  memories: number
  skipped: number
  summary?: SummaryEntry
}

// ── pi 可执行文件定位（与 pi-cron.sh 同策略） ──
// 优先解析到真实 cli.js（pi-original symlink / 直接 symlink），
// 避免 spawn 到 pi-wrapper.sh：提取子进程是后台一次性任务，
// 不应经过 wrapper 的崩溃计数/自动重启/回滚逻辑。

export function findPiBin(): string | null {
  const envBin = process.env.PI_BIN
  if (envBin && existsSync(envBin)) return envBin
  const home = homedir()
  const globs = [
    join(home, '.local/share/pi-node'),
    join(home, '.nvm/versions/node'),
  ]
  for (const base of globs) {
    let entries: string[] = []
    try { entries = readdirSync(base) } catch { continue }
    for (const sub of entries) {
      const binDir = join(base, sub, 'bin')
      // 1) pi-original：install-wrapper.sh 保留的原 CLI symlink
      const original = join(binDir, 'pi-original')
      if (existsSync(original)) {
        try {
          const target = realpathSync(original)
          if (target.endsWith('.js') && existsSync(target)) return target
        } catch { /* 继续尝试 */ }
      }
      // 2) bin/pi 若是直接指向 cli.js 的 symlink（未装 wrapper）
      const piBin = join(binDir, 'pi')
      if (existsSync(piBin)) {
        try {
          const target = realpathSync(piBin)
          if (target.endsWith('.js') && existsSync(target)) return target
        } catch { /* 不是 symlink（wrapper 脚本） */ }
      }
      // 3) 兜底：lib 目录下的 cli.js
      const libCli = join(base, sub, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
      if (existsSync(libCli)) return libCli
    }
  }
  for (const p of ['/usr/local/bin/pi', '/usr/bin/pi']) {
    if (existsSync(p)) {
      try {
        const target = realpathSync(p)
        if (target.endsWith('.js') && existsSync(target)) return target
      } catch { /* ignore */ }
    }
  }
  return null
}

// ── 提取互斥锁（防 parallelism：同刻只允许一个提取进程） ──

export const LOCK_FILE = join(DATA_DIR, '.extract-lock')

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireExtractLock(): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    // 审计修复（2026-08-25）：原子抢占（flag:'wx' 存在即失败 EEXIST），消除原
    // exists→rm→write 的 check-then-act 窗口（两进程可同时过 exists 检查后双双抢锁）
    try {
      writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false
    }
    // 锁已存在：验证 stale——读 pid 并探活，持有者存活则互斥失败
    let stale = true
    try {
      const pid = Number(readFileSync(LOCK_FILE, 'utf8').trim())
      if (pidAlive(pid)) stale = false
    } catch {
      /* 读失败/内容损坏（非 pid）→ 按 stale 处理 */
    }
    if (!stale) return false
    // stale 锁：rm + 原子重写一次（若间隙被其他进程抢占，'wx' 再失败 → 返回 false）
    try {
      rmSync(LOCK_FILE, { force: true })
      writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}

export function releaseExtractLock(): void {
  try {
    const cur = Number(readFileSync(LOCK_FILE, 'utf8'))
    if (cur === process.pid) rmSync(LOCK_FILE, { force: true })
  } catch {
    /* ignore */
  }
}

// ── 子进程执行（可注入 runner 便于测试） ──
// 提取子进程的会话文件写入隔离目录（~/.pi/memory/extract-sessions），
// 避免在真实会话目录（agent/sessions/）累积 "会话记忆提取器" 垃圾会话文件。

export const EXTRACT_SESSIONS_DIR = join(DATA_DIR, 'extract-sessions')

export type Runner = (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number | null }>

export const defaultRunner: Runner = (bin, args, timeoutMs) =>
  new Promise(resolve => {
    try {
      mkdirSync(EXTRACT_SESSIONS_DIR, { recursive: true })
    } catch { /* 目录创建失败不影响提取 */ }
    const proc = spawn(bin, args, {
      env: {
        ...process.env,
        NO_COLOR: '1',
        PI_MEMORY_EXTRACT: '1',
        PI_CODING_AGENT_SESSION_DIR: EXTRACT_SESSIONS_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    let settled = false
    const done = (out: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      done({ stdout, stderr, code: null })
    }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', code => {
      clearTimeout(timer)
      done({ stdout, stderr, code })
    })
    proc.on('error', err => {
      // 审计 LOW：原实现丢弃已累积的 stdout/stderr（传空串）——spawn 失败时
      // stderr 可能已有数据（如动态加载器报错），保留排障信息
      done({ stdout, stderr: stderr || err.message, code: null })
    })
  })

// ── Prompt 构造 ──

export function buildExtractPrompt(messages: ExtractMessage[], maxChars = 16000): string {
  let transcript = ''
  for (const m of messages) {
    const tag = m.role === 'user' ? '用户' : '助手'
    transcript += `\n<${tag}>${m.content}</${tag}>`
  }
  // 超限时保留最近消息（尾部）
  if (transcript.length > maxChars) {
    transcript = transcript.slice(-maxChars)
  }
  return `你是一个会话记忆提取器。从下面的对话中提取值得长期记住的信息，并生成会话摘要。

输出严格 JSON（不要 markdown 代码围栏，不要任何额外文字）：
{
  "summary": {
    "title": "20字以内的摘要标题",
    "decisions": ["重要决策，每条40字内"],
    "facts": ["关键事实，每条40字内"],
    "prefs": ["用户偏好/习惯，每条40字内"],
    "lessons": ["经验教训/踩坑，每条40字内"],
    "fullText": "300字以内的完整摘要，供后续会话衔接"
  },
  "memories": [
    {
      "category": "fact|preference|habit|procedure|reference|solutions",
      // solutions=成功的解决方案/修复模式（新任务注入时优先参考）
      "title": "20字以内的标题",
      "content": "150字以内的详情，自包含、可直接复用",
      "tags": ["标签"],
      "confidence": 0.0-1.0
    }
  ]
}

规则：
- memories 最多 8 条，只提取值得长期记忆的内容：用户偏好/习惯、项目约定、环境事实、可复用流程、重要决策、经验教训
- solutions 类别：本会话成功解决的故障/修复方案（含原因与解决步骤），供新任务注入时优先参考同类成功案例；通用知识类仍归 fact/procedure
- 不提取：临时性/一次性任务指令、当前会话的中间状态、时间戳类流水账、纯闲聊
- 自包含：每条记忆须能在不看原文的情况下独立理解，写明对象与上下文，不用"它/他/那个"等指代
- 保留专有名词、精确数字与限定词：产品名、版本号、端口、路径、人名不泛化（写"deepseek-v4-flash"不写"模型"）
- 时间锚定：对话中的相对时间（昨天/上周/最近）一律解析为具体日期（YYYY-MM-DD）
- 附带事实：用户在提问、抱怨、请求中顺带透露的个人/环境信息同样提取（如"我服务器磁盘80%"中的环境事实）
- confidence：直接观察到的事实 0.9-1.0，推断 0.5-0.7
- 没有可提取内容时 memories 返回空数组，summary 仍要输出

对话：
---${transcript}`
}

// ── 解析（容错） ──

export function parseExtractResult(raw: string): ExtractResult | null {
  if (!raw) return null
  let text = raw.trim()
  // 去掉 markdown fence
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  // 截取首个 { 到末个 }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    if (!data || typeof data !== 'object') return null
    const summary = data.summary || {}
    const memories: CandidateMemory[] = Array.isArray(data.memories)
      ? data.memories
          .filter((m: CandidateMemory) =>
            m && typeof m.title === 'string' && typeof m.content === 'string')
          .map((m: CandidateMemory) => ({
            category: (['fact', 'preference', 'habit', 'procedure', 'reference', 'solutions'] as string[]).includes(m.category)
              ? m.category as MemoryCategory
              : 'fact' as MemoryCategory,
            title: m.title.slice(0, 60),
            content: m.content.slice(0, 1000),
            tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).slice(0, 30)).slice(0, 8) : [],
            confidence: typeof m.confidence === 'number' ? Math.min(1, Math.max(0, m.confidence)) : 0.7,
          }))
          .slice(0, 8)
      : []
    return {
      summary: {
        title: typeof summary.title === 'string' ? summary.title.slice(0, 60) : '会话摘要',
        decisions: arr(summary.decisions),
        facts: arr(summary.facts),
        prefs: arr(summary.prefs),
        lessons: arr(summary.lessons),
        fullText: typeof summary.fullText === 'string' ? summary.fullText.slice(0, 1500) : '',
      },
      memories,
    }
  } catch {
    return null
  }
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.slice(0, 200)) : []
}

// ── 幂等与限频 ──

// 匿名会话（sessionId 为 null/空/'unknown'）不能用固定 'global' key：
// 两个不同匿名会话同消息数时，第二个会被 24h 冷却误跳过（tracker/disk
// 双残留，跨进程场景实测）。改为进程级随机 key：同进程内 compact+shutdown
// 双路径共享同一 key 保持幂等；跨进程匿名会话互不干扰（匿名会话本就无法
// 跨进程识别，恢复场景无会话上下文可依赖）。
const ANON_TRACKER_KEY = `anon:${randomUUID().slice(0, 8)}`
function trackerKey(sessionId: string | null | undefined): string {
  return sessionId && sessionId !== 'unknown' ? sessionId : ANON_TRACKER_KEY
}

interface TrackKey {
  sessionId: string
  fingerprint: number
}

const tracker = new Map<string, TrackKey>()

// 指纹持久化（审计发现）：tracker 仅存内存，重启后失效 → 同一段对话在
// compact/shutdown 双路径被重复提取（实测 pending 目录出现多个同 sessionId 残留）。
// 落盘后跨进程/重启幂等。读-改-写合并防提取子进程并发覆盖。
const TRACKER_FILE = join(DATA_DIR, 'extract-tracker.json')
let diskTrackerCache: Record<string, { fingerprint: number; lastTs: number }> | null = null
function loadDiskTracker(): Record<string, { fingerprint: number; lastTs: number }> {
  if (diskTrackerCache) return diskTrackerCache
  try {
    const parsed = JSON.parse(readFileSync(TRACKER_FILE, 'utf-8'))
    if (parsed && typeof parsed === 'object') diskTrackerCache = parsed
  } catch {
    /* 首次运行或损坏：重建 */
  }
  return (diskTrackerCache ??= {})
}

function diskHit(sessionId: string | null | undefined): TrackKey | undefined {
  const rec = loadDiskTracker()[trackerKey(sessionId)]
  if (!rec) return undefined
  return { sessionId: trackerKey(sessionId), fingerprint: rec.fingerprint }
}

export function shouldExtract(sessionId: string, messageCount: number, cooldownMs = 24 * 3600 * 1000): boolean {
  const key = trackerKey(sessionId)
  const prev = tracker.get(key) ?? diskHit(key)
  const now = Date.now()
  if (!prev) return true
  // 同指纹且冷却期内 → 跳过（幂等：同会话同消息数重复触发不重复提取）。
  // 审计 MEDIUM：冷却原为 60s——compact 提取 + shutdown 入队后重启超冷却即重复提取
  // （title 匹配虚增 recurrence）；提至 24h 覆盖隔夜重启场景，超期后同指纹重提靠 merge NOOP 兜底
  if (prev.fingerprint === messageCount && now - lastExtractTs(key) < cooldownMs) return false
  return true
}

const lastTs = new Map<string, number>()
export function lastExtractTs(sessionId: string): number {
  const key = trackerKey(sessionId)
  const mem = lastTs.get(key)
  if (mem) return mem
  return loadDiskTracker()[key]?.lastTs ?? 0
}

export function markExtracted(sessionId: string, messageCount: number): void {
  const key = trackerKey(sessionId)
  tracker.set(key, { sessionId: key, fingerprint: messageCount })
  lastTs.set(key, Date.now())
  const disk = loadDiskTracker()
  // 审计 LOW 修复：匿名会话的进程级随机 key 永不过期清理，长期无界增长——
  // 写入时顺带清理超过 7 天未更新的 anon key（真实会话 key 按 sessionId 可追溯不在此列）
  const ANON_TTL_MS = 7 * 24 * 3600 * 1000
  for (const k of Object.keys(disk)) {
    if (k.startsWith('anon:') && Date.now() - (disk[k]?.lastTs ?? 0) > ANON_TTL_MS) delete disk[k]
  }
  disk[key] = { fingerprint: messageCount, lastTs: Date.now() }
  try {
    writeJSONAtomic(TRACKER_FILE, disk)
  } catch {
    /* 只读文件系统等：降级为仅内存指纹 */
  }
}

// ── 退出期提取队列（延迟到下次启动消费） ──
// session_shutdown 时同步 spawn 提取子进程会阻塞退出（冷启动 ~19s + LLM 最长 60s）。
// 改为：shutdown 时把 transcript 落盘（毫秒级），下次 session_start 后台消费，
// 既保证退出零等待，又不丢提取。

export const PENDING_DIR = join(DATA_DIR, 'pending-extracts')

export interface PendingExtract {
  sessionId: string
  messageCount: number
  createdAt: number
  /** 失败重试计数（审计修复：无上限时坏任务每次 session_start 无限重试） */
  attempts?: number
  messages: ExtractMessage[]
}

/** pending 任务重试上限与过期窗口（坏任务不永久滞留、不无限 spawn 提取子进程） */
export const PENDING_MAX_ATTEMPTS = 3
export const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000

export function queuePendingExtract(messages: ExtractMessage[], sessionId: string | null): string | null {
  try {
    mkdirSync(PENDING_DIR, { recursive: true })
    // 按同 sessionId + 同消息数去重（审计：compact 提取过 + shutdown 又入队，
    // 同段对话被提取两次；消息数不同说明有新内容，仍入队）
    for (const existing of listPendingExtracts()) {
      if (existing.sessionId === (sessionId || 'unknown') && existing.messageCount === messages.length) {
        return null
      }
    }
    const file = join(PENDING_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}-${sanitizeFile(sessionId || 'unknown')}.json`)
    const job: PendingExtract = {
      sessionId: sessionId || 'unknown',
      messageCount: messages.length,
      createdAt: Date.now(),
      messages,
    }
    // 审计 LOW：pending 落盘 raw transcript 未经 scrub，与落库层净化口径不一致——
    // 写盘前对 JSON 序列化结果脱敏（占位符替换不破坏 JSON 结构）
    writeFileSync(file, scrubSecrets(JSON.stringify(job)))
    return file
  } catch {
    return null
  }
}

function sanitizeFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
}

export function listPendingExtracts(): PendingExtract[] {
  let files: string[] = []
  try {
    files = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const jobs: PendingExtract[] = []
  for (const f of files) {
    try {
      jobs.push(JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf8')))
    } catch { /* 跳过损坏文件 */ }
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt)
}

export function removePendingExtract(file: string): void {
  try {
    rmSync(join(PENDING_DIR, file), { force: true })
  } catch { /* ignore */ }
}

// 消费所有 pending 提取（session_start 后台调用）。串行逐个提取，失败保留队列。
export async function processPendingExtracts(opts: ExtractOptions = {}): Promise<{ ok: number; failed: number }> {
  let listed: string[] = []
  try {
    listed = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json')).sort()
  } catch {
    return { ok: 0, failed: 0 }
  }
  let ok = 0
  let failed = 0
  for (const file of listed) {
    let job: PendingExtract
    try {
      job = JSON.parse(readFileSync(join(PENDING_DIR, file), 'utf8'))
    } catch {
      removePendingExtract(file)
      continue
    }
    // 过期任务直接丢弃（超过 7 天的陈旧对话无提取价值）
    if (Date.now() - job.createdAt > PENDING_MAX_AGE_MS) {
      removePendingExtract(file)
      failed++
      continue
    }
    const outcome = await extractConversation(job.messages, {
      sessionId: job.sessionId,
      messageCount: job.messageCount,
      maxChars: opts.maxChars,
      timeoutMs: opts.timeoutMs,
      runner: opts.runner,
    })
    if (outcome.ok) {
      removePendingExtract(file)
      ok++
    } else if (outcome.skipped > 0) {
      // 审计修复 HIGH-4：cooldown/锁竞争 skip 不是失败——不递增 attempts、
      // 不删文件（3 次 skip 曾永久删除从未成功提取过的 job）、不计 failed
      continue
    } else {
      // 失败计数写回：超过上限删除（坏任务不再每次 session_start 无限重试）
      job.attempts = (job.attempts ?? 0) + 1
      if (job.attempts >= PENDING_MAX_ATTEMPTS) {
        removePendingExtract(file)
      } else {
        try {
          // 失败计数写回同样过 scrub（对象与 401 同源，保持一致）；
          // 审计 LOW 修复：改原子写（tmp+rename），崩溃半写会使下轮解析失败
          // 走 removePendingExtract 静默删除该对话
          const target = join(PENDING_DIR, file)
          const tmp = `${target}.${process.pid}.tmp`
          writeFileSync(tmp, scrubSecrets(JSON.stringify(job)), 'utf-8')
          renameSync(tmp, target)
        } catch { /* 写回失败保留原文件（残留 tmp 由系统临时目录语义兜底） */ }
      }
      failed++
    }
  }
  // 清理提取子进程遗留的会话文件（超过 24 小时无清理，审计实测 395 个残留）
  cleanupExtractSessions()
  return { ok, failed }
}

/** 清理提取子进程会话隔离目录中的过期文件（子进程无扩展无法自清理，父进程兜底） */
export function cleanupExtractSessions(maxAgeMs = 24 * 3600 * 1000): void {
  let entries: string[]
  try {
    entries = readdirSync(EXTRACT_SESSIONS_DIR)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    try {
      const st = statSync(join(EXTRACT_SESSIONS_DIR, name))
      if (now - st.mtimeMs > maxAgeMs) rmSync(join(EXTRACT_SESSIONS_DIR, name), { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}

// ── 主流程 ──

export interface ExtractOptions {
  sessionId?: string | null
  messageCount?: number
  maxChars?: number
  timeoutMs?: number
  runner?: Runner
}

export async function extractConversation(
  messages: ExtractMessage[],
  opts: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const sessionId = opts.sessionId || 'unknown'
  if (!shouldExtract(sessionId, opts.messageCount ?? messages.length)) {
    return { ok: false, error: 'skip: cooldown or duplicate', memories: 0, skipped: 1 }
  }
  if (!messages.length) return { ok: false, error: 'empty conversation', memories: 0, skipped: 0 }
  if (!acquireExtractLock()) {
    return { ok: false, error: 'skip: another extraction in progress', memories: 0, skipped: 1 }
  }

  try {
    return await doExtract(messages, opts, sessionId)
  } finally {
    releaseExtractLock()
  }
}

async function doExtract(
  messages: ExtractMessage[],
  opts: ExtractOptions,
  sessionId: string,
): Promise<ExtractOutcome> {
  const bin = findPiBin()
  if (!bin && !opts.runner) {
    return { ok: false, error: '找不到 pi 可执行文件', memories: 0, skipped: 0 }
  }

  const prompt = buildExtractPrompt(messages, opts.maxChars)
  const runner = opts.runner ?? defaultRunner
  // --no-extensions（2026-08-28）：提取是纯 LLM 调用，无需任何扩展；实测部分扩展的
  // 常驻定时器会挂住 -p 模式 event loop——回答完成后进程不退出，60s 超时被 SIGKILL，
  // 全部提取报"code: timeout"失败（08-27 起 summaries.json 断档根因）。附带收益：
  // 跳过 11 个扩展加载，冷启动更快、不与主实例抢调度锁。
  const { stdout, stderr, code } = await runner(bin ?? '', ['--no-extensions', '-p', prompt], opts.timeoutMs ?? 60_000)

  // 超时/进程被杀（code null）或非零退出：明确报错而不是解析垃圾输出
  if (code !== 0) {
    return {
      ok: false,
      error: `提取进程退出异常 (code: ${code ?? 'timeout'}): ${stderr.slice(0, 200)}`,
      memories: 0,
      skipped: 0,
    }
  }

  const result = parseExtractResult(stdout)
  if (!result) {
    return {
      ok: false,
      error: `提取解析失败: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
      memories: 0,
      skipped: 0,
    }
  }

  // 落库
  const entries = loadEntries()
  const candidates: MemoryEntry[] = result.memories.map(m => ({
    id: randomUUID(),
    category: m.category,
    title: m.title,
    content: m.content,
    tags: m.tags,
    confidence: m.confidence,
    source: 'extract',
    recurrence: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    // 自动提取的条目默认打当前环境标签（会话内操作的环境相关）
    environments: [detectEnvironment()],
    // v4: 会话归属（跨会话轮转分组）
    lastSessionId: sessionId === 'unknown' ? undefined : sessionId,
  }))
  const { applied, skipped } = await mergeCandidates(entries, candidates)

  // 摘要存档（质量门：无实质内容类摘要不落库——审计发现 4 条"开场问候无实质
  // 内容"空摘要进入注入块展示残留；过滤依据：无任何提取物且文案自认无可提取）
  const emptySummaryPattern = /无可提取|无实质内容|无需衔接|没有可提取|未提取到内容|无任务执行|无有效信息|无有价值信息/
  const hasSubstance = result.summary.decisions.length > 0
    || result.summary.facts.length > 0
    || result.summary.prefs.length > 0
    || result.summary.lessons.length > 0
  const selfAdmitsEmpty = emptySummaryPattern.test(result.summary.title + result.summary.fullText)
  if (!hasSubstance && selfAdmitsEmpty) {
    markExtracted(sessionId, opts.messageCount ?? messages.length)
    return { ok: true, memories: applied.length, skipped: skipped.length }
  }
  const summary: SummaryEntry = {
    id: randomUUID(),
    sessionId: sessionId === 'unknown' ? null : sessionId,
    ts: new Date().toISOString(),
    title: result.summary.title,
    decisions: result.summary.decisions,
    facts: result.summary.facts,
    prefs: result.summary.prefs,
    lessons: result.summary.lessons,
    fullText: result.summary.fullText,
  }
  appendSummary(summary)
  markExtracted(sessionId, opts.messageCount ?? messages.length)
  return { ok: true, memories: applied.length, skipped: skipped.length, summary }
}

// 从会话条目中提取纯文本消息（供事件层调用）
// 长会话保留最近 200 条（头部是系统注入/早期上下文，尾部才贴近本次提取目标）
// 入参使用官方 SessionEntry 类型；仅 message 条目承载对话文本（官方
// SessionMessageEntry.message: AgentMessage），其余条目（模型变更/压缩等）无内容可提
const MAX_EXTRACT_MESSAGES = 200
export function extractTextFromEntries(entries: SessionEntry[]): ExtractMessage[] {
  const out: ExtractMessage[] = []
  for (const e of entries) {
    if (e.type !== 'message') continue
    const msg = e.message
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    // role 收窄后 content 为官方 TextContent/ImageContent(及 thinking/toolCall) 数组或纯文本
    const content = msg.content
    if (!content) continue
    const text = extractText(content)
    if (!text.trim()) continue
    out.push({ role: msg.role, content: text })
    // 超过上限时丢弃最旧，保留最近消息
    if (out.length > MAX_EXTRACT_MESSAGES) out.shift()
  }
  return out
}

function extractText(content: string | readonly unknown[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => (c as { text?: string }).text ?? '')
    .join('\n')
}

export { tokenize }
