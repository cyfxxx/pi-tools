import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  pruneToolResults,
  pruneThinkingBudget,
  sweepPruneRefs,
  isPrunedMessage,
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

  it('新默认（120K/80K）：5 轮×5万 token 不再触发（预算覆盖 2 条后耗尽、回收 0 < 80K 最低）', () => {
    // 2026-08-18 审计：保护带提至 120K/80K 后，会话早期 5 轮×50K 的输出完全被保护带
    // 覆盖 + 回收不足最低阈值 → 不擦除（append-only：宁可多留上下文也不承担缓存断裂）
    const msgs = session(5, 200_000)
    const r = pruneToolResults(msgs)
    expect(r.modified).toBe(false)
    expect(r.prunedCount).toBe(0)
  })

  it('更大会话量（8 轮×5万 token）才跨过保护带触发擦除', () => {
    // 8 轮：toolResult index 2,5,8,11,14,17,20,23（各 50K）。最近 2 轮豁免（index 18+）。
    // 120K 预算覆盖 17,14，index 11 扣尽残余 → 预算耗尽后 index 8,5,2 擦除（回收 150K ≥ 80K）
    const msgs = session(8, 200_000)
    const r = pruneToolResults(msgs)
    expect(r.modified).toBe(true)
    expect(r.prunedCount).toBe(3)
    for (const i of [2, 5, 8]) {
      expect(messageText(r.messages[i])).toMatch(/^\[pruned: \d+ chars\]$/)
    }
    for (const i of [11, 14, 17, 20, 23]) {
      expect(messageText(r.messages[i])).toContain('y')
    }
  })

  it('回收低于 minimumTokens → 不应用（保持原样）', () => {
    const outputSize = 10_000 // 每条约 2.5K token，远低于保护带
    const msgs = session(10, outputSize)
    const r = pruneToolResults(msgs)
    expect(r.modified).toBe(false)
    expect(r.prunedCount).toBe(0)
  })

  it('擦除单调性：追加新回合后旧擦除点保持擦除（占位不恢复）', () => {
    const before = pruneToolResults(session(8, 200_000))
    expect(before.modified).toBe(true)
    expect(messageText(before.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
    // 追加新轮后：已擦占位保持（单调性），且因占位不再贡献回收、残留预算覆盖更多，
    // 后续轮基本不再触发新擦除（120K/80K 下擦除近一次性——符合 append-only 意图）
    const extended = [...before.messages, user(), assistant(), toolResult('z'.repeat(200_000))]
    const after = pruneToolResults(extended)
    expect(messageText(after.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
    expect(messageText(after.messages[5])).toMatch(/^\[pruned: \d+ chars\]$/)
    expect(messageText(after.messages[8])).toMatch(/^\[pruned: \d+ chars\]$/)
  })

  it('已擦除判定：正文含 "[pruned:" 字面量（非开头）不误判，仍被正常擦除（审计修复）', () => {
    // 场景：工具输出恰好包含 marker 字面量（如 cat 本文件源码的输出）。旧判定
    // includes 会把该消息误判为已擦除而跳过 → 原文常驻上下文。
    const msgs = session(8, 200_000)
    // index 2 的输出：字面量在正文中部（前面有真实输出文本）
    msgs[2] = toolResult(`文件内容如下：
[pruned: 12345 chars]
${'y'.repeat(200_000)}`)
    const r = pruneToolResults(msgs)
    // 修复后：该消息不被误判，与其他早期消息一样进入擦除（3 条全擦）
    expect(r.prunedCount).toBe(3)
    expect(isPrunedMessage(msgs[2])).toBe(false)
    expect(messageText(r.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
  })

  it('已擦除判定：真实擦除后的消息（marker 开头）仍被识别，重扫不重复擦除', () => {
    const first = pruneToolResults(session(8, 200_000))
    const pruned = first.messages[2]
    expect(isPrunedMessage(pruned)).toBe(true)
    // 重扫（更激进参数）：已擦除消息被跳过，marker 稳定不被重写/恢复
    const second = pruneToolResults(first.messages, { protectTokens: 0, minimumTokens: 0 })
    expect(messageText(second.messages[2])).toMatch(/^\[pruned: \d+ chars\]$/)
    expect(second.messages[2]).toBe(pruned) // 同一对象原样返回（未被重选）
  })

  it('已擦除判定：非 toolRole 消息不误判；marker 前导空白容忍', () => {
    // user/assistant 正文即使以字面量开头也不判为已擦除（角色门卫）
    expect(isPrunedMessage({ role: 'user', content: [{ type: 'text', text: '[pruned: 1 chars]' }] })).toBe(false)
    expect(isPrunedMessage({ role: 'assistant', content: [{ type: 'text', text: '[pruned: 1 chars]' }] })).toBe(false)
    // toolRole + marker 开头（含前导空白）→ 已擦除
    expect(isPrunedMessage(toolResult('[pruned: 1 chars]'))).toBe(true)
    expect(isPrunedMessage(toolResult('  \n[pruned: 1 chars]'))).toBe(true)
    // toolRole + 带 ref 的 marker 开头 → 已擦除
    expect(isPrunedMessage(toolResult('[pruned: 5 chars → /tmp/ref.txt]'))).toBe(true)
    // toolRole + 字面量在中部 → 未擦除
    expect(isPrunedMessage(toolResult('output... [pruned: 1 chars] more'))).toBe(false)
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

  it('常数：缓存友好调优（2026-08-18 审计：120K/80K 阈值下普通会话不触发，append-only 优先）', () => {
    expect(PRUNE_PROTECT_TOKENS).toBe(120_000)
    expect(PRUNE_MINIMUM_TOKENS).toBe(80_000)
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
describe('pruneToolResults: dumpRef 擦除溯源（refs 卸载）', () => {
  it('dumpRef 返回路径 → marker 内嵌路径，回调收到完整原文', () => {
    const refs: string[] = []
    const msgs = session(3)
    const r = pruneToolResults(msgs, {
      minimumTokens: 0,
      protectTokens: 0,
      keepRecentTurns: 0,
      dumpRef: (text, meta) => {
        expect(meta.chars).toBe(text.length)
        refs.push(text)
        return `/tmp/refs/${meta.index}.md`
      },
    })
    expect(r.modified).toBe(true)
    const prunedMsg = r.messages.find((m, i) => m !== msgs[i])!
    const text = messageText(prunedMsg)
    expect(text).toContain('[pruned:')
    expect(text).toContain('→ /tmp/refs/')
  })

  it('dumpRef 抛错 → 降级为纯 chars marker，擦除不受影响', () => {
    const msgs = session(3)
    const r = pruneToolResults(msgs, {
      minimumTokens: 0,
      protectTokens: 0,
      keepRecentTurns: 0,
      dumpRef: () => {
        throw new Error('disk full')
      },
    })
    expect(r.modified).toBe(true)
    const prunedMsg = r.messages.find((m, i) => m !== msgs[i])!
    expect(messageText(prunedMsg)).toMatch(/^\[pruned: \d+ chars\]$/)
  })

  it('dumpRef 返回 null → 纯 chars marker', () => {
    const msgs = session(3)
    const r = pruneToolResults(msgs, { minimumTokens: 0, protectTokens: 0, keepRecentTurns: 0, dumpRef: () => null })
    expect(r.modified).toBe(true)
    const prunedMsg = r.messages.find((m, i) => m !== msgs[i])!
    expect(messageText(prunedMsg)).toMatch(/^\[pruned: \d+ chars\]$/)
  })

  it('已擦除消息（含 sentinel）跳过：不重选、不再回调 dumpRef', () => {
    const calls: number[] = []
    const msgs = session(3)
    // 第一轮：全部擦除
    const r1 = pruneToolResults(msgs, {
      minimumTokens: 0,
      protectTokens: 0,
      keepRecentTurns: 0,
      dumpRef: (_t, meta) => {
        calls.push(meta.index)
        return '/tmp/refs/x.md'
      },
    })
    expect(calls.length).toBeGreaterThan(0)
    // 第二轮：对已擦除结果再次扫描 → 无修改、dumpRef 零调用
    const callsBefore = calls.length
    const r2 = pruneToolResults(r1.messages, {
      minimumTokens: 0,
      protectTokens: 0,
      keepRecentTurns: 0,
      dumpRef: (_t, meta) => {
        calls.push(meta.index)
        return '/tmp/refs/x.md'
      },
    })
    expect(r2.modified).toBe(false)
    expect(calls.length).toBe(callsBefore)
  })
})

describe('sweepPruneRefs: 擦除溯源目录清理', () => {
  it('过期文件按 mtime 删除，新文件保留；总量超限从最旧删起', async () => {
    const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'prune-refs-'))
    const oldFile = join(dir, 'old.md')
    const newFile = join(dir, 'new.md')
    writeFileSync(oldFile, 'x'.repeat(100))
    writeFileSync(newFile, 'y'.repeat(100))
    // old 设为 30 天前
    const past = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(oldFile, past, past)

    const stats = await sweepPruneRefs(dir, { retentionDays: 14 })
    expect(stats.scanned).toBe(2)
    expect(stats.deletedByAge).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(newFile)).toBe(true)

    // 总量上限：新文件 100 字节，maxTotalBytes=50 → 从最旧（即仅剩的 new）删起
    const stats2 = await sweepPruneRefs(dir, { retentionDays: -1, maxTotalBytes: 50 })
    expect(stats2.deletedBySize).toBe(1)
    expect(existsSync(newFile)).toBe(false)
})

  it('目录不存在 → 空统计不抛错', async () => {
    const stats = await sweepPruneRefs('/nonexistent/prune-refs-xyz')
    expect(stats.scanned).toBe(0)
    expect(stats.deletedByAge).toBe(0)
  })
})
