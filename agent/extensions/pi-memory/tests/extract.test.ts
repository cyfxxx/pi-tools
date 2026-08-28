import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Runner } from '../extract.ts'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'

let dir: string
const ORIG_ENV = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-memory-ext-'))
  process.env.PI_MEMORY_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_MEMORY_DIR
  rmSync(dir, { recursive: true, force: true })
})

const VALID_JSON = JSON.stringify({
  summary: {
    title: '修复 CI 配置',
    decisions: ['采用 GitHub Actions 构建'],
    facts: ['node 版本为 20'],
    prefs: ['用户偏好简洁注释'],
    lessons: ['记得先跑 lint'],
    fullText: '本次会话修复了 CI 配置问题',
  },
  memories: [
    {
      category: 'preference',
      title: '用户偏好: 简洁注释',
      content: '用户希望代码注释保持简洁，不写冗余说明',
      tags: ['style', 'user'],
      confidence: 0.95,
    },
  ],
})

describe('extract: parseExtractResult', () => {
  it('parses clean JSON output', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    const result = parseExtractResult(VALID_JSON)
    expect(result).not.toBeNull()
    expect(result!.summary.title).toBe('修复 CI 配置')
    expect(result!.memories).toHaveLength(1)
    expect(result!.memories[0].category).toBe('preference')
  })

  it('strips markdown fences', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    const result = parseExtractResult(`\`\`\`json\n${VALID_JSON}\n\`\`\``)
    expect(result).not.toBeNull()
    expect(result!.memories).toHaveLength(1)
  })

  it('tolerates leading/trailing prose', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    const result = parseExtractResult(`好的，以下是提取结果：\n${VALID_JSON}\n希望能帮助到你。`)
    expect(result).not.toBeNull()
    expect(result!.memories[0].title).toBe('用户偏好: 简洁注释')
  })

  it('returns null for invalid JSON', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    expect(parseExtractResult('')).toBeNull()
    expect(parseExtractResult('not json at all')).toBeNull()
    expect(parseExtractResult('{"broken":')).toBeNull()
  })

  it('sanitizes category fallback and clips fields', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    const raw = JSON.stringify({
      summary: { title: 't'.repeat(200), fullText: 'x'.repeat(5000) },
      memories: [
        { category: 'evil', title: 'a'.repeat(500), content: 'b'.repeat(5000), tags: ['t'.repeat(100)], confidence: 5 },
      ],
    })
    const result = parseExtractResult(raw)
    expect(result).not.toBeNull()
    expect(result!.memories[0].category).toBe('fact')
    expect(result!.memories[0].title.length).toBeLessThanOrEqual(60)
    expect(result!.memories[0].content.length).toBeLessThanOrEqual(1000)
    expect(result!.memories[0].tags[0].length).toBeLessThanOrEqual(30)
    expect(result!.memories[0].confidence).toBe(1)
  })

  it('drops malformed memory items', async () => {
    const { parseExtractResult } = await import('../extract.ts')
    const raw = JSON.stringify({
      summary: { title: 'ok' },
      memories: [
        { category: 'fact', title: 'no content' },
        { title: 'no category no content', confidence: 0.5 },
        { category: 'fact', title: 'good', content: 'fine' },
      ],
    })
    const result = parseExtractResult(raw)
    expect(result!.memories).toHaveLength(1)
    expect(result!.memories[0].title).toBe('good')
  })
})

describe('extract: extractConversation full flow', () => {
  it('extract worker guard: PI_MEMORY_EXTRACT env enables worker mode (HIGH-3)', async () => {
    const { isExtractWorker } = await import('../extract.ts')
    const prev = process.env.PI_MEMORY_EXTRACT
    process.env.PI_MEMORY_EXTRACT = '1'
    expect(isExtractWorker()).toBe(true)
    delete process.env.PI_MEMORY_EXTRACT
    expect(isExtractWorker()).toBe(false)
    if (prev !== undefined) process.env.PI_MEMORY_EXTRACT = prev
  })

  it('extracts, merges, and persists entries + summary via mock runner', async () => {
    const { extractConversation } = await import('../extract.ts')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    const outcome = await extractConversation(
      [
        { role: 'user', content: '帮我修复 CI 配置' },
        { role: 'assistant', content: '已修复，采用 GitHub Actions' },
      ],
      { sessionId: 'sess-1', messageCount: 2, runner },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.memories).toBe(1)

    const { loadEntries, loadSummaries } = await import('../storage.ts')
    const entries = loadEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe('extract')
    expect(entries[0].title).toBe('用户偏好: 简洁注释')
    expect(entries[0].observedAt).toBeTruthy()

    const summaries = loadSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0].title).toBe('修复 CI 配置')
    expect(summaries[0].sessionId).toBe('sess-1')
  })

  it('is idempotent: same fingerprint within cooldown is skipped', async () => {
    const { extractConversation } = await import('../extract.ts')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const first = await extractConversation(messages, { sessionId: 'sess-2', messageCount: 2, runner })
    expect(first.ok).toBe(true)
    const second = await extractConversation(messages, { sessionId: 'sess-2', messageCount: 2, runner })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('skip')

    const { loadEntries } = await import('../storage.ts')
    expect(loadEntries()).toHaveLength(1)
  })

  it('first extraction works when DATA_DIR does not exist yet (lock dir auto-created)', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'pi-memory-fresh-'))
    rmSync(freshDir, { recursive: true, force: true })
    process.env.PI_MEMORY_DIR = freshDir
    vi.resetModules()
    const { extractConversation } = await import('../extract.ts')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    const outcome = await extractConversation(
      [{ role: 'user', content: 'hi' }],
      { sessionId: 'sess-fresh', messageCount: 1, runner },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    const { loadEntries } = await import('../storage.ts')
    expect(loadEntries()).toHaveLength(1)
    rmSync(freshDir, { recursive: true, force: true })
    process.env.PI_MEMORY_DIR = dir
    vi.resetModules()
  })

  it('different message count is not skipped', async () => {
    const { extractConversation } = await import('../extract.ts')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    await extractConversation([{ role: 'user', content: 'a' }], { sessionId: 'sess-3', messageCount: 1, runner })
    const second = await extractConversation(
      [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
      { sessionId: 'sess-3', messageCount: 2, runner },
    )
    expect(second.ok).toBe(true)
  })

  it('fails gracefully when parse fails', async () => {
    const { extractConversation } = await import('../extract.ts')
    const runner: Runner = async () => ({ stdout: 'garbage', stderr: '', code: 0 })
    const outcome = await extractConversation([{ role: 'user', content: 'x' }], { sessionId: 'sess-4', runner })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('提取解析失败')
  })

  it('empty conversation → error without invoking runner', async () => {
    const { extractConversation } = await import('../extract.ts')
    let called = false
    const runner: Runner = async () => { called = true; return { stdout: '', stderr: '', code: 0 } }
    const outcome = await extractConversation([], { sessionId: 'sess-5', runner })
    expect(outcome.ok).toBe(false)
    expect(called).toBe(false)
  })
})

describe('extract: pending queue (deferred shutdown extraction)', () => {
  it('queue → file persisted; process consumes and removes on success', async () => {
    const { queuePendingExtract, processPendingExtracts, listPendingExtracts } = await import('../extract.ts')
    const file = queuePendingExtract([{ role: 'user', content: 'hi' }], 'sess-p1')
    expect(file).toBeTruthy()
    expect(listPendingExtracts()).toHaveLength(1)

    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    const { ok, failed } = await processPendingExtracts({ runner })
    expect(ok).toBe(1)
    expect(failed).toBe(0)
    expect(listPendingExtracts()).toHaveLength(0)
  })

  it('failed extraction keeps the queue entry for retry', async () => {
    const { queuePendingExtract, processPendingExtracts, listPendingExtracts } = await import('../extract.ts')
    queuePendingExtract([{ role: 'user', content: 'hi' }], 'sess-p2')
    const runner: Runner = async () => ({ stdout: 'garbage', stderr: '', code: 0 })
    const { ok, failed } = await processPendingExtracts({ runner })
    expect(ok).toBe(0)
    expect(failed).toBe(1)
    expect(listPendingExtracts()).toHaveLength(1)
  })

  it('bad job dropped after max attempts (不再无限重试)', async () => {
    const { queuePendingExtract, processPendingExtracts, listPendingExtracts } = await import('../extract.ts')
    queuePendingExtract([{ role: 'user', content: 'hi' }], 'sess-p2b')
    const runner: Runner = async () => ({ stdout: 'garbage', stderr: '', code: 0 })
    // 连续 3 次失败（每次 attempts+1）后任务被删除
    await processPendingExtracts({ runner })
    await processPendingExtracts({ runner })
    const { ok, failed } = await processPendingExtracts({ runner })
    expect(ok).toBe(0)
    expect(failed).toBe(1)
    expect(listPendingExtracts()).toHaveLength(0)
  })

  it('skip (cooldown/lock) keeps queue entry without attempts (HIGH-4)', async () => {
    const { queuePendingExtract, processPendingExtracts, listPendingExtracts, markExtracted } = await import('../extract.ts')
    // 制造冷却指纹：markExtracted('sess-pp', 1) → 同 sessionId+count 的入队 job 提取时被 skip
    markExtracted('sess-pp', 1)
    queuePendingExtract([{ role: 'user', content: 'hi' }], 'sess-pp')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    // 连续 3 次 skip（旧行为：每次 attempts+1，3 次后删除从未成功提取过的 job）
    const r1 = await processPendingExtracts({ runner })
    expect(r1.ok).toBe(0)
    expect(r1.failed).toBe(0)
    const r2 = await processPendingExtracts({ runner })
    const r3 = await processPendingExtracts({ runner })
    expect(r2.failed).toBe(0)
    expect(r3.failed).toBe(0)
    expect(listPendingExtracts()).toHaveLength(1)
  })

  it('queue dedupes same sessionId + messageCount', async () => {
    const { queuePendingExtract, listPendingExtracts } = await import('../extract.ts')
    const msg = [{ role: 'user' as const, content: 'hi' }]
    expect(queuePendingExtract(msg, 'sess-dup')).toBeTruthy()
    expect(queuePendingExtract(msg, 'sess-dup')).toBeNull()
    // 消息数不同（新内容）→ 仍入队
    expect(queuePendingExtract([...msg, { role: 'assistant' as const, content: 'hi2' }], 'sess-dup')).toBeTruthy()
    expect(listPendingExtracts()).toHaveLength(2)
  })

  it('corrupted queue files are dropped without breaking the batch', async () => {
    const { queuePendingExtract, processPendingExtracts, listPendingExtracts } = await import('../extract.ts')
    queuePendingExtract([{ role: 'user', content: 'hi' }], 'sess-p3')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'pending-extracts', '0-corrupt.json'), 'not json')
    const runner: Runner = async () => ({ stdout: VALID_JSON, stderr: '', code: 0 })
    const { ok, failed } = await processPendingExtracts({ runner })
    expect(ok).toBe(1)
    expect(failed).toBe(0)
    expect(listPendingExtracts()).toHaveLength(0)
  })
})

describe('extract: prompt building', () => {
  it('builds prompt with transcript and truncates beyond maxChars', async () => {
    const { buildExtractPrompt } = await import('../extract.ts')
    const messages = [
      { role: 'user' as const, content: '你好'.repeat(5000) },
      { role: 'assistant' as const, content: '再见' },
    ]
    const prompt = buildExtractPrompt(messages, 1000)
    expect(prompt).toContain('记忆提取器')
    expect(prompt).toContain('再见')
    expect(prompt.length).toBeLessThan(3000)
  })
})

describe('extract: 指纹持久化（重启防重复提取）', () => {
  it('markExtracted 落盘后新模块实例 shouldExtract 跳过同指纹', async () => {
    const { markExtracted } = await import('../extract.ts')
    markExtracted('sess-1', 42)
    vi.resetModules()
    const fresh = await import('../extract.ts')
    // 同指纹 + 冷却期内 → 新进程（重启后）也跳过
    expect(fresh.shouldExtract('sess-1', 42)).toBe(false)
    // 不同消息数 → 允许提取
    expect(fresh.shouldExtract('sess-1', 43)).toBe(true)
    // 未标记过的会话 → 允许
    expect(fresh.shouldExtract('sess-new', 10)).toBe(true)
  })
  it('匿名会话不共用固定 key：跨进程（新模块实例）同消息数不被冷却跳过（LOW 修复）', async () => {
    const { markExtracted } = await import('../extract.ts')
    // 匿名会话（null 归一 'unknown'）提取并落盘
    markExtracted(null as unknown as string, 10)
    vi.resetModules()
    const fresh = await import('../extract.ts')
    // 修复前：新进程匿名会话命中磁盘 'global' key → 同指纹 24h 内被跳过；
    // 修复后：进程级随机 key → 视为不同匿名会话，允许提取
    expect(fresh.shouldExtract(null as unknown as string, 10)).toBe(true)
    expect(fresh.shouldExtract('unknown', 10)).toBe(true)
  })

  it('同进程内匿名会话双路径仍幂等（compact+shutdown 共享进程 key 不重复提取）', async () => {
    const { shouldExtract, markExtracted } = await import('../extract.ts')
    expect(shouldExtract(null as unknown as string, 7)).toBe(true)
    markExtracted(null as unknown as string, 7)
    // 同进程内再次触发（compact 后 shutdown 入队处理）→ 同指纹冷却期内跳过
    expect(shouldExtract('unknown', 7)).toBe(false)
    // 消息数不同 → 仍允许（新内容）
    expect(shouldExtract(null as unknown as string, 8)).toBe(true)
  })
})

describe('extract: extractTextFromEntries', () => {
  it('extracts text blocks from session entries', async () => {
    const { extractTextFromEntries } = await import('../extract.ts')
    const base = { id: '1', parentId: null, timestamp: '2026-01-01T00:00:00Z' }
    const entries = [
      { ...base, id: 'a', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 } },
      { ...base, id: 'b', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'plain text' }], timestamp: 1 } },
      { ...base, id: 'c', type: 'model_change', provider: 'anthropic', modelId: 'claude' },
      { ...base, id: 'd', type: 'message', message: { role: 'custom', customType: 'usage-diag', content: 'ignored', display: true, timestamp: 1 } },
      { ...base, id: 'e', type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], timestamp: 1 } },
    ] as unknown as SessionEntry[]
    const messages = extractTextFromEntries(entries)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('hello')
    expect(messages[1].content).toBe('plain text')
  })
})

describe('extract: pending 落盘净化（审计 L4 修复）', () => {
  it('含密钥消息落盘前被 scrub，不落明文', async () => {
    const { queuePendingExtract, PENDING_DIR } = await import('../extract.ts')
    const { readFileSync, readdirSync } = await import('node:fs')
    const secret = 'sk-abc12345def67890ghi'
    queuePendingExtract([{ role: 'user', content: `token=${secret}` }], 'sess-scrub')
    const files = readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const raw = readFileSync(PENDING_DIR + '/' + files[0], 'utf-8')
    expect(raw).not.toContain(secret)
    expect(raw).toContain('[REDACTED:api-key]')
  })
})

describe('extract: acquireExtractLock（审计修复：wx 原子抢占 + stale 验证）', () => {
  it('首次抢占成功，锁文件内容为当前 pid', async () => {
    const { acquireExtractLock, LOCK_FILE } = await import('../extract.ts')
    expect(acquireExtractLock()).toBe(true)
    expect(readFileSync(LOCK_FILE, 'utf8')).toBe(String(process.pid))
  })

  it('锁被存活进程持有 → 互斥失败（wx EEXIST 路径，不 rm 不覆盖）', async () => {
    const { acquireExtractLock, LOCK_FILE } = await import('../extract.ts')
    // 以本进程 pid 模拟持有者存活（kill(pid,0) 探活成功）
    writeFileSync(LOCK_FILE, String(process.pid))
    expect(acquireExtractLock()).toBe(false)
    // 原持锁内容未被覆盖
    expect(readFileSync(LOCK_FILE, 'utf8')).toBe(String(process.pid))
  })

  it('stale 锁（pid 不存在）→ 清理后重新抢占', async () => {
    const { acquireExtractLock, LOCK_FILE } = await import('../extract.ts')
    writeFileSync(LOCK_FILE, '999999999') // 超出 Linux pid 上限，探活必失败
    expect(acquireExtractLock()).toBe(true)
    expect(readFileSync(LOCK_FILE, 'utf8')).toBe(String(process.pid))
  })

  it('锁内容损坏（非 pid）→ 按 stale 处理，可重新抢占', async () => {
    const { acquireExtractLock, LOCK_FILE } = await import('../extract.ts')
    writeFileSync(LOCK_FILE, 'garbage-not-a-pid')
    expect(acquireExtractLock()).toBe(true)
    expect(readFileSync(LOCK_FILE, 'utf8')).toBe(String(process.pid))
  })

  it('releaseExtractLock 只删自己的锁，不动他人锁；无锁时可安全调用', async () => {
    const { acquireExtractLock, releaseExtractLock, LOCK_FILE } = await import('../extract.ts')
    expect(() => releaseExtractLock()).not.toThrow() // 无锁
    expect(acquireExtractLock()).toBe(true)
    releaseExtractLock()
    expect(existsSync(LOCK_FILE)).toBe(false)
    // 他人锁（pid ≠ 自身）释放时保留
    writeFileSync(LOCK_FILE, '999999999')
    releaseExtractLock()
    expect(existsSync(LOCK_FILE)).toBe(true)
  })
})
