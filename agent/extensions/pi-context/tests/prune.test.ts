import { describe, it, expect } from 'vitest'
import {
  pruneToolResults,
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
    // 保护带预算 40K 只够保留更早 1 条（index 8）→ index 5、2 被擦除。
    const msgs = session(5, 200_000)
    const r = pruneToolResults(msgs)
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

  it('常数：与 opencode 默认值对齐', () => {
    expect(PRUNE_PROTECT_TOKENS).toBe(40_000)
    expect(PRUNE_MINIMUM_TOKENS).toBe(20_000)
    expect(KEEP_RECENT_TURNS).toBe(2)
  })
})