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

import { truncateToolContent } from '../index.ts'

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
