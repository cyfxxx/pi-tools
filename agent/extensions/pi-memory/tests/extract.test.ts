import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
