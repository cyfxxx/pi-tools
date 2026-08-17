import { describe, it, expect } from 'vitest'
import { buildInjectionBlock, filterInjectedMessages } from '../inject.ts'
import type { MemoryEntry, SummaryEntry } from '../types.ts'

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = new Date().toISOString()
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    category: 'fact',
    title: 'test entry',
    content: 'test content for memory entry',
    tags: ['test'],
    confidence: 0.8,
    source: 'manual',
    recurrence: 1,
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id: 's1',
    sessionId: null,
    ts: new Date().toISOString(),
    title: '会话摘要',
    decisions: [],
    facts: [],
    prefs: [],
    lessons: [],
    fullText: '这是一段会话摘要内容',
    ...overrides,
  }
}

describe('inject: buildInjectionBlock', () => {
  it('returns block within token budget', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry({ title: `记忆条目 ${i}`, content: '内容 '.repeat(50) }))
    const summaries = Array.from({ length: 5 }, (_, i) => makeSummary({ title: `摘要 ${i}`, fullText: '摘要正文'.repeat(80) }))
    const result = buildInjectionBlock(entries, summaries, 500)
    expect(result.tokens).toBeLessThanOrEqual(600)
    expect(result.entries).toBeGreaterThan(0)
    expect(result.block).toContain('持续记忆')
  })

  it('caps entries at 4 max', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry({ title: `记忆 ${i}`, content: '短内容' }))
    const result = buildInjectionBlock(entries, [], 2000)
    expect(result.entries).toBeLessThanOrEqual(4)
  })

  it('includes recent summaries up to 2', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const summaries = [
      makeSummary({ title: 'old one' }),
      makeSummary({ title: 'new one' }),
      makeSummary({ title: 'latest' }),
    ]
    const result = buildInjectionBlock([], summaries, 500)
    expect(result.summaries).toBeGreaterThan(0)
    expect(result.summaries).toBeLessThanOrEqual(2)
  })

  it('empty entries and summaries → still returns empty block', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const result = buildInjectionBlock([], [], 500)
    expect(result.entries).toBe(0)
    expect(result.summaries).toBe(0)
    expect(result.block).toContain('持续记忆')
  })

  it('marks block with injection tag', async () => {
    const { buildInjectionBlock, INJECT_TAG, isInjectionBlock } = await import('../inject.ts')
    const result = buildInjectionBlock([makeEntry()], [], 500)
    expect(isInjectionBlock(result.block)).toBe(true)
    expect(INJECT_TAG).toBe('pi-memory-injection')
  })

  it('is byte-stable for identical data (cache-prefix friendly: no timestamps)', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const entries = [makeEntry({ title: '稳定条目', content: '固定内容' })]
    const summaries = [makeSummary({ title: '固定摘要', fullText: '固定摘要正文' })]
    const a = buildInjectionBlock(entries, summaries, 500)
    // 同一份数据不同时刻生成 → 输出必须完全一致（不得含时间戳等动态文本）
    const b = buildInjectionBlock(entries, summaries, 500)
    expect(a.block).toBe(b.block)
    // 标记行无动态时间戳
    expect(a.block).toContain('> pi-memory-injection')
    expect(a.block).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })

  it('超长内容带 [truncated] 标记截断（不再硬切残句）', async () => {
    const { buildInjectionBlock, CONTENT_TOKEN_CAP } = await import('../inject.ts')
    const longContent = '这是一段非常长的内容。'.repeat(60)
    const result = buildInjectionBlock([makeEntry({ title: '长条目', content: longContent })], [], 2000)
    expect(result.block).toContain('[truncated')
    expect(result.block.length).toBeLessThan(longContent.length)
  })

  it('短内容不加截断标记', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const result = buildInjectionBlock([makeEntry({ title: '短条目', content: '短内容' })], [], 2000)
    expect(result.block).not.toContain('[truncated')
  })

  it('空摘要（无可提取类）不注入', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const empty = makeSummary({
      title: '开场问候无实质内容',
      fullText: '本会话仅有问候，无可提取的长期记忆，无需衔接',
    })
    const substantive = makeSummary({ title: '有效摘要', fullText: '用户偏好：使用 Shell 管理', decisions: ['d1'] })
    const result = buildInjectionBlock([], [empty, substantive], 500)
    expect(result.summaries).toBe(1)
    expect(result.block).toContain('有效摘要')
    expect(result.block).not.toContain('开场问候')
  })

  it('摘要按 ts 排序取最新而非数组插入序', async () => {
    const { buildInjectionBlock } = await import('../inject.ts')
    const older = makeSummary({ title: '旧摘要-不应出现', ts: '2026-01-01T00:00:00Z', fullText: '旧内容' })
    const newer = makeSummary({ title: '新摘要', ts: '2026-02-01T00:00:00Z', fullText: '新内容' })
    const middle = makeSummary({ title: '中摘要', ts: '2026-01-15T00:00:00Z', fullText: '中内容' })
    // 数组序打乱（旧在尾）——排序后应取 new/mid
    const result = buildInjectionBlock([], [newer, older, middle], 2000)
    expect(result.block).toContain('新摘要')
    expect(result.block).toContain('中摘要')
    expect(result.block).not.toContain('旧摘要-不应出现')
  })
})

describe('buildInjectionBlock 环境过滤', () => {
  function entry(partial: Partial<MemoryEntry>): MemoryEntry {
    return {
      id: crypto.randomUUID(),
      category: 'fact',
      title: 't',
      content: 'c',
      tags: [],
      confidence: 1,
      source: 'manual',
      recurrence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      ...partial,
    }
  }

  it('只注入 all + 当前环境条目（termux 环境）', () => {
    const all = entry({ title: '通用', content: '通用知识', environments: ['all'] })
    const termux = entry({ title: 'Termux 知识', content: '录音经验', environments: ['termux'] })
    const wsl2 = entry({ title: 'WSL 知识', content: 'clipboard 经验', environments: ['wsl2'] })
    const noEnv = entry({ title: '旧数据', content: '无环境字段' })
    const r = buildInjectionBlock([all, termux, wsl2, noEnv], [], 1000, 'termux')
    expect(r.block).toContain('通用')
    expect(r.block).toContain('Termux 知识')
    expect(r.block).toContain('旧数据')
    expect(r.block).not.toContain('WSL 知识')
    expect(r.entries).toBe(3)
  })

  it('wsl2 环境注入 wsl2 条目不注入 termux 条目', () => {
    const termux = entry({ title: 'Termux 知识', content: '录音经验', environments: ['termux'] })
    const wsl2 = entry({ title: 'WSL 知识', content: 'clipboard 经验', environments: ['wsl2'] })
    const r = buildInjectionBlock([termux, wsl2], [], 1000, 'wsl2')
    expect(r.block).toContain('WSL 知识')
    expect(r.block).not.toContain('Termux 知识')
  })
})

describe('filterInjectedMessages: 注入消息去重（防累积）', () => {
  const inj = (n: number) => ({ customType: 'pi-memory-injection', content: `block-${n}` })

  it('无注入消息时原样返回', () => {
    const msgs = [{ customType: 'plan-execution-context' }, { customType: undefined }]
    expect(filterInjectedMessages(msgs)).toEqual(msgs)
  })

  it('多条历史注入只保留最新一条（倒序第一条 = 最新）', () => {
    const msgs = [inj(1), { customType: 'user-msg' }, inj(2), inj(3)]
    const out = filterInjectedMessages(msgs)
    expect(out).toHaveLength(2)
    expect(out.filter(m => m.customType === 'pi-memory-injection')).toEqual([inj(3)])
    // 其余消息顺序不变
    expect(out.map(m => m.customType)).toEqual(['user-msg', 'pi-memory-injection'])
  })

  it('单条注入保持不变', () => {
    const msgs = [inj(1), { customType: 'x' }]
    expect(filterInjectedMessages(msgs)).toEqual(msgs)
  })
})
