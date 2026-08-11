import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { MemoryCategory, MemoryEntry, SummaryEntry } from './types.ts'
import { loadEntries, saveEntries, appendSummary, tokenize, DATA_DIR } from './storage.ts'
import { mergeCandidates } from './merge.ts'
import { detectEnvironment } from './env.ts'

export interface ExtractMessage {
  role: 'user' | 'assistant'
  content: string
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
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, 'utf8'))
      if (pidAlive(pid)) return false
      rmSync(LOCK_FILE, { force: true })
    }
    writeFileSync(LOCK_FILE, String(process.pid))
    return true
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
      done({ stdout: '', stderr: err.message, code: null })
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
      "category": "fact|preference|habit|procedure|reference",
      "title": "20字以内的标题",
      "content": "150字以内的详情，自包含、可直接复用",
      "tags": ["标签"],
      "confidence": 0.0-1.0
    }
  ]
}

规则：
- memories 最多 8 条，只提取值得长期记忆的内容：用户偏好/习惯、项目约定、环境事实、可复用流程、重要决策、经验教训
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
            category: (['fact', 'preference', 'habit', 'procedure', 'reference'] as string[]).includes(m.category)
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

interface TrackKey {
  sessionId: string
  fingerprint: number
}

const tracker = new Map<string, TrackKey>()

export function shouldExtract(sessionId: string, messageCount: number, cooldownMs = 60_000): boolean {
  const key = sessionId || 'global'
  const prev = tracker.get(key)
  const now = Date.now()
  if (!prev) return true
  // 同指纹且冷却期内 → 跳过（幂等：同会话同消息数重复触发不重复提取）
  if (prev.fingerprint === messageCount && now - lastExtractTs(key) < cooldownMs) return false
  return true
}

const lastTs = new Map<string, number>()
export function lastExtractTs(sessionId: string): number {
  return lastTs.get(sessionId || 'global') ?? 0
}

export function markExtracted(sessionId: string, messageCount: number): void {
  const key = sessionId || 'global'
  tracker.set(key, { sessionId, fingerprint: messageCount })
  lastTs.set(key, Date.now())
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
  messages: ExtractMessage[]
}

export function queuePendingExtract(messages: ExtractMessage[], sessionId: string | null): string | null {
  try {
    mkdirSync(PENDING_DIR, { recursive: true })
    const file = join(PENDING_DIR, `${Date.now()}-${sanitizeFile(sessionId || 'unknown')}.json`)
    const job: PendingExtract = {
      sessionId: sessionId || 'unknown',
      messageCount: messages.length,
      createdAt: Date.now(),
      messages,
    }
    writeFileSync(file, JSON.stringify(job))
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
    } else {
      failed++
    }
  }
  return { ok, failed }
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
    return { ok: false, error: 'skip: cooldown or duplicate', memories: 0, skipped: 0 }
  }
  if (!messages.length) return { ok: false, error: 'empty conversation', memories: 0, skipped: 0 }
  if (!acquireExtractLock()) {
    return { ok: false, error: 'skip: another extraction in progress', memories: 0, skipped: 0 }
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
  const { stdout, stderr, code } = await runner(bin ?? '', ['-p', prompt], opts.timeoutMs ?? 60_000)

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
  }))
  const { applied, skipped } = await mergeCandidates(entries, candidates)

  // 摘要存档
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
