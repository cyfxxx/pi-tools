import { describe, it, expect, vi } from 'vitest'

// 测试环境 alias 将 @earendil-works/* 映射为空 mock（仅类型导出）；
// 这里注入与真实 SDK 语义一致的 truncateHead/truncateTail 供截断路径使用。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  truncateHead: (text: string, opts: { maxBytes: number }) => {
    const head = Buffer.from(text, 'utf8').subarray(0, opts.maxBytes).toString('utf8')
    return { content: head, outputBytes: Buffer.byteLength(head, 'utf8') }
  },
  truncateTail: (text: string, opts: { maxBytes: number }) => {
    const buf = Buffer.from(text, 'utf8')
    const tail = buf.subarray(Math.max(0, buf.length - opts.maxBytes)).toString('utf8')
    return { content: tail, outputBytes: Buffer.byteLength(tail, 'utf8') }
  },
}))

import { truncateToolContent, updateFailStreak } from '../index.ts'

function textBlock(text: string) {
  return { type: 'text' as const, text }
}
function imageBlock() {
  return { type: 'image' as const, data: 'base64-image-data', mimeType: 'image/png' }
}
function textOf(content: unknown): string {
  const block = (content as { type: string; text: string }[])
  return block.find((c) => c.type === 'text')?.text ?? ''
}

describe('truncateToolContent: R4 工具输出截断', () => {
  it('未超限 → undefined（不修改事件）', () => {
    const content = [textBlock('短输出'), imageBlock()]
    expect(truncateToolContent('read', content, 5000)).toBeUndefined()
  })

  it('bash 超限 → truncateTail 保留尾部', () => {
    const big = `head-${'x'.repeat(8000)}-tail`
    const r = truncateToolContent('bash', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('[...truncated')
    expect(text).toContain('-tail')
    expect(text).not.toContain('head-')
  })

  it('read 超限 → truncateHead 保留头部', () => {
    const big = `head-${'y'.repeat(8000)}-tail`
    const r = truncateToolContent('read', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('head-')
    expect(text).not.toContain('-tail')
  })

  it('read 返回图片 + 超 5KB 文本 → 图片块保留不丢弃（LOW 审计回归）', () => {
    const img = imageBlock()
    const big = 'z'.repeat(8000)
    const r = truncateToolContent('read', [img, textBlock(big)], 5000)
    expect(r).toBeDefined()
    expect(r!.content).toHaveLength(2)
    expect(r!.content[0]).toEqual(img)
    expect(r!.content[1].type).toBe('text')
    expect(textOf(r!.content)).toContain('[...truncated')
  })

  it('多非 text 块全部保留（图片 + 自定义块）', () => {
    const img1 = imageBlock()
    const img2 = { ...imageBlock(), data: 'second-image' }
    const r = truncateToolContent('read', [img1, img2, textBlock('w'.repeat(8000))], 5000)
    expect(r).toBeDefined()
    expect(r!.content).toHaveLength(3)
    expect(r!.content[0]).toEqual(img1)
    expect(r!.content[1]).toEqual(img2)
    expect(r!.content[2].type).toBe('text')
  })

  it('omittedBytes = 原字节数 - 截断后字节数', () => {
    const big = 'q'.repeat(8000)
    const r = truncateToolContent('read', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    // 截断目标为 cap 减去截断标记预算（64 字节），保证最终字节数不超 cap
    expect(r!.omittedBytes).toBe(8000 - (5000 - 64))
  })
})

describe('truncateToolContent: JSON 内容路由（确定性结构压缩）', () => {
  const jsonArr = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, v: 'x'.repeat(30) })))

  it('合法 JSON 数组超限 → 保前段 + 截断标记', () => {
    expect(Buffer.byteLength(jsonArr, 'utf8')).toBeGreaterThan(5000)
    const r = truncateToolContent('bash', [textBlock(jsonArr)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('[...truncated')
    const jsonPart = text.split('\n\n[...truncated')[0]
    const parsed = JSON.parse(jsonPart) // 压缩后仍是合法 JSON
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeLessThan(200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(5000)
  })

  it('合法 JSON 对象超限 → 保前键', () => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < 100; i++) obj[`key${i}`] = 'v'.repeat(60)
    const big = JSON.stringify(obj)
    const r = truncateToolContent('bash', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    const jsonPart = text.split('\n\n[...truncated')[0]
    const parsed = JSON.parse(jsonPart) as Record<string, string>
    expect(parsed['key0']).toBeDefined()
    expect(Object.keys(parsed).length).toBeLessThan(100)
  })

  it('JSON 后接日志（非纯 JSON）→ 回退通用截断', () => {
    const big = jsonArr + '\nsome trailing log line that is long '.repeat(50)
    const r = truncateToolContent('read', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('[...truncated')
  })

  it('单条超长字符串 JSON → 回退通用截断（不产生非法片段）', () => {
    const big = JSON.stringify({ msg: 'x'.repeat(20000), tail: 'end' })
    const r = truncateToolContent('read', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('[...truncated')
    expect(text).not.toContain('"tail')
  })

  it('确定性：同一输入两次压缩输出逐字节一致（缓存友好）', () => {
    const a = truncateToolContent('bash', [textBlock(jsonArr)], 5000)
    const b = truncateToolContent('bash', [textBlock(jsonArr)], 5000)
    expect(textOf(a!.content)).toBe(textOf(b!.content))
  })
})

describe('truncateToolContent: 错误确定性脱水（12-factor factor-09）', () => {
  it('无错误标记 → 不改变文本（走通用截断）', () => {
    const big = 'normal line\n'.repeat(3000)
    const r = truncateToolContent('bash', [textBlock(big)], 5000)
    expect(r).toBeDefined()
    // 走通用截断：无折叠标记
    expect(textOf(r!.content)).not.toContain('行重复已折叠')
  })

  it('错误标记 + 连续重复行 → 折叠为 2 行 + 标记（原超限，脱水后免截断）', () => {
    const err = 'Error: connection refused\n' + ('same error line\n'.repeat(600)) + 'tail kept here'
    expect(Buffer.byteLength(err, 'utf8')).toBeGreaterThan(5000)
    const r = truncateToolContent('bash', [textBlock(err)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('行重复已折叠')
    expect(text).toContain('Error: connection refused')
    expect(text).toContain('tail kept here') // 头部尾部都保留
  })

  it('错误标记 + 超长行 → 行截断', () => {
    const err = 'Error: boom\n' + 'stack-frame-xyz '.repeat(1000)
    expect(Buffer.byteLength(err, 'utf8')).toBeGreaterThan(5000)
    const r = truncateToolContent('bash', [textBlock(err)], 5000)
    expect(r).toBeDefined()
    expect(textOf(r!.content)).toContain('[行截断]')
  })

  it('错误文本脱水后仍在 cap 内 → 免通用截断完整保留头尾', () => {
    const err = 'Error: start here\n' + 'dup line\n'.repeat(3000) + 'end marker here'
    expect(Buffer.byteLength(err, 'utf8')).toBeGreaterThan(5000)
    const r = truncateToolContent('bash', [textBlock(err)], 5000)
    expect(r).toBeDefined()
    const text = textOf(r!.content)
    expect(text).toContain('Error: start here')
    expect(text).toContain('end marker here') // 未砍头砍尾
    expect(text).toContain('行重复已折叠')
  })
})

describe('updateFailStreak: 连续失败熔断计数', () => {
  it('同一工具连续失败 3 次触发熔断提示，4 次不重复触发', () => {
    const streak = new Map<string, number>()
    const r1 = updateFailStreak(streak, 'bash', true)
    expect(r1.hint).toBeUndefined()
    const r2 = updateFailStreak(streak, 'bash', true)
    expect(r2.hint).toBeUndefined()
    const r3 = updateFailStreak(streak, 'bash', true)
    expect(r3.hint).toBeDefined()
    const r4 = updateFailStreak(streak, 'bash', true)
    expect(r4.hint).toBeUndefined() // 已在熔断态，不重复追加
  })

  it('中途成功清零连击', () => {
    const streak = new Map<string, number>()
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', false) // 成功清零
    const r = updateFailStreak(streak, 'bash', true)
    expect(r.hint).toBeUndefined() // 重新从 1 计数
  })

  it('不同工具独立计数', () => {
    const streak = new Map<string, number>()
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', true)
    expect(updateFailStreak(streak, 'read', true).hint).toBeUndefined()
    expect(updateFailStreak(streak, 'read', true).hint).toBeUndefined()
    expect(updateFailStreak(streak, 'read', true).hint).toBeDefined()
  })

  it('失败计数不因熔断触发后重置（连续失败仍保持计数）', () => {
    const streak = new Map<string, number>()
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', true)
    updateFailStreak(streak, 'bash', true)
    expect(streak.get('bash')).toBe(4)
  })
})
