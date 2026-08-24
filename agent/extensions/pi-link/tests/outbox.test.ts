import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
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

  it('原子写：tmp+rename 落盘，无 .tmp 残留且文件始终完整 JSON（审计 LOW）', () => {
    appendOutbox('devA', '原子写一')
    appendOutbox('devA', '原子写二')
    // rename 后无残留 tmp（原地 writeFileSync 实现不会产生 tmp，但此断言同时守护
    // “rename 失败/异常中断不留垃圾文件”）
    const leftovers = readdirSync(dirname(outboxFilePath())).filter(f => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    // 主文件为完整 JSON 且内容正确
    const raw = JSON.parse(readFileSync(outboxFilePath(), 'utf8')) as { device: string; entries: unknown[] }
    expect(raw.device).toBe('devA')
    expect(raw.entries).toHaveLength(2)
    expect(readOutbox()[1].text).toBe('原子写二')
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
