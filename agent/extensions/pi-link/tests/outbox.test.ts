import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// mock homedir → 临时目录
const TMP = join(tmpdir(), `pi-link-outbox-test-${Date.now()}`)
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TMP }
})

import { appendOutbox, readOutbox, extractFinalReply, OUTBOX_MAX, outboxFilePath } from '../outbox.ts'
import { dirname } from 'node:path'

describe('pi-link: outbox 信箱', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true })
    try { rmSync(outboxFilePath(), { force: true }) } catch { /* */ }
  })
  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch { /* */ }
  })

  it('append/read 往返', () => {
    appendOutbox('devA', '回复一')
    appendOutbox('devA', '回复二')
    const entries = readOutbox()
    expect(entries.length).toBe(2)
    expect(entries[0].text).toBe('回复一')
    expect(entries[1].text).toBe('回复二')
    expect(entries[1].ts).toBeGreaterThan(0)
  })

  it('环形缓冲：超出上限丢弃最旧', () => {
    for (let i = 0; i < OUTBOX_MAX + 5; i++) appendOutbox('devA', `回复${i}`)
    const entries = readOutbox()
    expect(entries.length).toBe(OUTBOX_MAX)
    expect(entries[0].text).toBe('回复5')
    expect(entries[entries.length - 1].text).toBe(`回复${OUTBOX_MAX + 4}`)
  })

  it('文件缺失/损坏时 read 返回空数组', () => {
    expect(readOutbox()).toEqual([])
    mkdirSync(dirname(outboxFilePath()), { recursive: true })
    writeFileSync(outboxFilePath(), 'not-json{{{')
    expect(readOutbox()).toEqual([])
  })

  it('extractFinalReply: 取最后一条 assistant 文本', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', text: '思考中' }, { type: 'text', text: '你好' }] },
      { role: 'tool', content: [] },
      { role: 'assistant', content: [{ type: 'toolCall' }, { type: 'text', text: '最终回复' }] },
    ]
    expect(extractFinalReply(msgs)).toBe('最终回复')
  })

  it('extractFinalReply: 无 assistant 文本返回 undefined', () => {
    expect(extractFinalReply([])).toBeUndefined()
    expect(extractFinalReply([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBeUndefined()
    expect(extractFinalReply(null as unknown as unknown[])).toBeUndefined()
  })

  it('extractFinalReply: 多段 text 拼接', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
    ]
    expect(extractFinalReply(msgs)).toBe('第一段\n第二段')
  })
})
