import { describe, it, expect } from 'vitest'
import {
  pruneToolResults,
  pruneThinkingBudget,
  PRUNE_PROTECT_TOKENS,
  PRUNE_MINIMUM_TOKENS,
  KEEP_RECENT_TURNS,
  messageText,
  type PruneMessage,
} from '../../../lib/prune.ts'

function toolResult(text: string): PruneMessage {
  return { role: 'toolResult', content: [{ type: 'text', text }] }
}
function user(): PruneMessage {
  return { role: 'user', content: [{ type: 'text', text: '用户消息' }] }
}
function assistant(): PruneMessage {
  return { role: 'assistant', content: [{ type: 'text', text: '助手回复' }] }
}

/** 构造一个会话：n 轮，每轮 user+assistant+toolResult（输出 outputSize 字符） */
function session(rounds: number, outputSize = 200_000): PruneMessage[] {
  const msgs: PruneMessage[] = []
  for (let i = 0; i < rounds; i++) {
    msgs.push(user())
    msgs.push(assistant())
    msgs.push(toolResult('y'.repeat(outputSize)))
  }
  return msgs
}

describe('pruneToolResults: 工具输出分层擦除', () => {
  it('空/无工具结果 → 无修改', () => {
    const r = pruneToolResults([])
    expect(r.modified).toBe(false)
    expect(r.prunedCount).toBe(0)
  })

  it('保护带内（最近轮次 + 预算内）不擦除', () => {
    const msgs = session(1)
    const r = pruneToolResults(msgs, { minimumTokens: 0 })
    expect(r.modified).toBe(false)
    expect(r.prunedCount).toBe(0)
  })

  it('超保护带的更早 toolResult 输出被替换为占位（保留结构）', () => {
    // 5 轮，每轮输出 20 万字符 ≈ 5 万 token。
    // opencode 语义：最近 2 轮（index 11、14）绝不擦除；
    // 显式传旧保护带 40K（新默认 80K 下 5 轮仅 1 条被擦，见下方新默认测试）——
    // 保护带预算只够保留更早 1 条（index 8）→ index 5、2 被擦除。
    const msgs = session(5, 200_000)
    const r = pruneToolResults(msgs, { protectTokens: 40_000, minimumTokens: 0 })
    expect(r.modified).toBe(true)
    expect(r.prunedCount).toBe(2)
    expect(r.messages[2].role).toBe('toolResult')
    expect(messageText(r.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
    expect(messageText(r.messages[5])).toMatch(/^\[pruned: \d+ chars\]$/)
    // 预算内保留（index 8）与最近 2 轮（index 11、14）未擦
    expect(messageText(r.messages[8])).toContain('y')
    expect(messageText(r.messages[11])).toContain('y')
    expect(messageText(r.messages[14])).toContain('y')
  })

  it('新默认（80K/50K）：5 轮×5万 token 仅擦 1 条（保护带翻倍降擦除频率，2026-08-15 审计）', () => {
    const msgs = session(5, 200_000)
    const r = pruneToolResults(msgs)
    expect(r.modified).toBe(true)
    // 80K 保护带可覆盖更早 2 条（index 8、5）→ 仅 index 2 被擦
    expect(r.prunedCount).toBe(1)
    expect(messageText(r.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
    expect(messageText(r.messages[5])).toContain('y')
    expect(messageText(r.messages[8])).toContain('y')
  })

  it('回收低于 minimumTokens → 不应用（保持原样）', () => {
    const outputSize = 10_000 // 每条约 2.5K token，远低于保护带
    const msgs = session(10, outputSize)
    const r = pruneToolResults(msgs)
    expect(r.modified).toBe(false)
    expect(r.prunedCount).toBe(0)
  })

  it('擦除单调性：追加新回合后旧擦除点保持擦除', () => {
    const before = pruneToolResults(session(5, 200_000))
    expect(before.modified).toBe(true)
    const extended = [...before.messages, user(), assistant(), toolResult('z'.repeat(200_000))]
    const after = pruneToolResults(extended)
    expect(after.modified).toBe(true)
    const firstTool = after.messages.findIndex((m, i) => i < 3 && m.role === 'toolResult')
    expect(firstTool).toBe(2)
    expect(messageText(after.messages[firstTool])).toMatch(/^\[pruned: \d+ chars\]$/)
  })

  it('messageText 只提取 text block', () => {
    const m: PruneMessage = {
      role: 'toolResult',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'other', text: '忽略' },
        { type: 'text', text: '第二段' },
      ],
    }
    expect(messageText(m)).toBe('第一段\n第二段')
  })

  it('非 text 块（图片等）参与擦除：被替换为占位文本块', () => {
    // 5 轮，toolResult 含图片块（非 text）→ 名义 1000 token/块参与预算判定；
    // 保护带外被擦除（index 2、5）的消息中 image 块也须被替换（修复前原样保留）
    const tool = (imgData: string): PruneMessage => ({
      role: 'toolResult',
      content: [
        { type: 'image', data: imgData, mimeType: 'image/png' },
        { type: 'text', text: 'y'.repeat(200_000) },
      ],
    })
    const msgs: PruneMessage[] = [
      user(), assistant(), tool('aaaa'),
      user(), assistant(), tool('bbbb'),
      user(), assistant(), tool('cccc'),
      user(), assistant(), tool('dddd'),
      user(), assistant(), tool('eeee'),
    ]
    const r = pruneToolResults(msgs, { protectTokens: 40_000, minimumTokens: 0 })
    expect(r.modified).toBe(true)
    // 被擦除消息（index 2、5）的 content 中不再残留 image 块（替换为占位文本块）
    const blockTypes = (m: PruneMessage): string[] =>
      Array.isArray(m.content) ? (m.content as { type?: string }[]).map((b) => b.type ?? '') : []
    expect(blockTypes(r.messages[2])).not.toContain('image')
    expect(blockTypes(r.messages[2])).toEqual(['text', 'text'])
    expect(blockTypes(r.messages[5])).not.toContain('image')
    expect(blockTypes(r.messages[5])).toEqual(['text', 'text'])
    const markers = (m: PruneMessage): string[] =>
      Array.isArray(m.content)
        ? (m.content as { type?: string; text?: string }[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
        : []
    expect(markers(r.messages[2]).every((t) => /^\[pruned: \d+ chars\]$/.test(t))).toBe(true)
    expect(markers(r.messages[5]).every((t) => /^\[pruned: \d+ chars\]$/.test(t))).toBe(true)
    // 预算内保留（index 8）与最近 2 轮（index 11、14）完整保留含图片
    expect(blockTypes(r.messages[8])).toContain('image')
    expect(blockTypes(r.messages[11])).toContain('image')
    expect(blockTypes(r.messages[14])).toContain('image')
  })

  it('自定义参数生效（protectTokens/minimumTokens/keepRecentTurns）', () => {
    const msgs = session(6, 100_000)
    const r = pruneToolResults(msgs, {
      protectTokens: 5_000,
      minimumTokens: 1_000,
      keepRecentTurns: 1,
    })
    expect(r.modified).toBe(true)
    expect(r.prunedCount).toBeGreaterThan(0)
  })

  it('常数：缓存友好调优（2026-08-15 审计：提高阈值降擦除频率，擦除轮必然破坏前缀缓存）', () => {
    expect(PRUNE_PROTECT_TOKENS).toBe(80_000)
    expect(PRUNE_MINIMUM_TOKENS).toBe(50_000)
    expect(KEEP_RECENT_TURNS).toBe(2)
  })
})

describe('pruneThinkingBudget: thinking 按 token 预算保留', () => {
  function assistantWithThinking(thinking: string, text = '回复'): PruneMessage {
    return { role: 'assistant', content: [{ type: 'thinking', thinking }, { type: 'text', text }] }
  }
  function user(): PruneMessage {
    return { role: 'user', content: [{ type: 'text', text: '用户消息' }] }
  }

  it('预算内（thinking 总量 < 预算）→ 不修改', () => {
    const msgs = [user(), assistantWithThinking('x'.repeat(1000)), assistantWithThinking('y'.repeat(2000))]
    const r = pruneThinkingBudget(msgs, 16_000)
    expect(r.modified).toBe(false)
  })

  it('超预算 → 预算耗尽处及更早的 thinking 删除，保留 text 块', () => {
    // 3 条 assistant，各 20K 字符 thinking ≈ 5K token；预算 8K 只够 1 条
    const msgs = [
      user(),
      assistantWithThinking('a'.repeat(20_000), '回复1'),
      assistantWithThinking('b'.repeat(20_000), '回复2'),
      assistantWithThinking('c'.repeat(20_000), '回复3'),
    ]
    const r = pruneThinkingBudget(msgs, 8_000)
    expect(r.modified).toBe(true)
    const contents = r.messages.map((m) => (Array.isArray(m.content) ? m.content : []))
    // 最近一条（index 3）完整保留
    expect(contents[3].filter((b) => b.type === 'thinking')).toHaveLength(1)
    // index 1、2 的 thinking 被删除，text 保留
    expect(contents[1].filter((b) => b.type === 'thinking')).toHaveLength(0)
    expect(contents[1].some((b) => b.type === 'text' && b.text === '回复1')).toBe(true)
    expect(contents[2].filter((b) => b.type === 'thinking')).toHaveLength(0)
    expect(contents[2].some((b) => b.type === 'text' && b.text === '回复2')).toBe(true)
    // 非 assistant 消息不受影响
    expect(r.messages[0].role).toBe('user')
  })

  it('预算刚好覆盖多条时按从后往前累计', () => {
    const big = [assistantWithThinking('c'.repeat(10_000)), assistantWithThinking('d'.repeat(10_000))]
    // 每条 10K 字符 ≈ 2500 token；预算 3000 只够保留最近 1 条
    const r = pruneThinkingBudget(big, 3_000)
    expect(r.modified).toBe(true)
    const contents = r.messages.map((m) => (Array.isArray(m.content) ? m.content : []))
    expect(contents[1].filter((b) => b.type === 'thinking')).toHaveLength(1)
    expect(contents[0].filter((b) => b.type === 'thinking')).toHaveLength(0)
  })

  it('无 thinking 的消息序列 → 不修改', () => {
    const msgs = [user(), { role: 'assistant', content: [{ type: 'text', text: '回复' }] }]
    const r = pruneThinkingBudget(msgs, 1_000)
    expect(r.modified).toBe(false)
  })
})