import { describe, it, expect, vi, beforeEach } from 'vitest'

const registeredTools: Array<{ name: string; execute: Function }> = []
const lifecycleHandlers: Record<string, Function> = {}

const mockPi = {
  registerTool: vi.fn((tool: { name: string; execute: Function }) => {
    registeredTools.push({ name: tool.name, execute: tool.execute })
  }),
  on: vi.fn((event: string, handler: Function) => {
    lifecycleHandlers[event] = handler
  }),
}

vi.mock('../config', () => ({
  loadConfig: () => ({
    search: { searxng_url: 'https://searx.be', timeout: 5000 },
  }),
}))

vi.mock('../search/impl', () => ({
  searchWeb: vi.fn().mockResolvedValue('搜索: "test"\n\n1. 结果一\n   https://example.com/1'),
}))

describe('pi-web-search (entry point)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredTools.length = 0
    Object.keys(lifecycleHandlers).forEach(k => delete lifecycleHandlers[k])
  })

  it('should register 3 search tools and session_start hook', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const toolNames = registeredTools.map(t => t.name).sort()
    expect(toolNames).toEqual(['fetch_url', 'web_fetch', 'web_search'])

    expect(lifecycleHandlers['session_start']).toBeDefined()
    expect(lifecycleHandlers['session_shutdown']).toBeUndefined()
  })

  it('web_search should return search results', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'web_search')!
    const result = await tool.execute('id', { query: 'test' }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('搜索')
  })

  it('web_fetch should return search results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><h2><a href="https://example.com/1">Result One</a></h2></body></html>'),
    }) as any

    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'web_fetch')!
    const result = await tool.execute('id', { query: 'test' }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('搜索')
  })

  it('fetch_url should fetch URL content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"status":"ok"}'),
    }) as any

    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'fetch_url')!
    const result = await tool.execute('id', { url: 'https://api.example.com/data.json' }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('"status":"ok"')
  })

  it('fetch_url !ok should cancel response body (no hanging connection)', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', body: { cancel } }) as any

    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'fetch_url')!
    const result = await tool.execute('id', { url: 'https://api.example.com/x' }, undefined, undefined, {} as any)
    expect(result.content[0].text).toContain('HTTP 503')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('readBodyLimited should cancel reader when body exceeds cap and flag truncated', async () => {
    let cancelled = false
    let pulls = 0
    // pull 式流且永不 close：模拟服务器持续发大响应（真实场景下 cancel 才会真正触发）
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new Uint8Array(512 * 1024).fill(65)) },
      cancel() { cancelled = true },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream }) as any

    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'fetch_url')!
    // max_length 调小，避免整体被 pruneToolOutput 裁剪吞掉截断标记
    const result = await tool.execute('id', { url: 'https://api.example.com/big', max_length: 200 }, undefined, undefined, {} as any)
    expect(pulls).toBeGreaterThanOrEqual(2)   // 确实读满了 cap 并多读了一块
    expect(cancelled).toBe(true)              // 读满后必须 cancel，避免连接悬挂
    expect(result.content[0].text).toContain('已截断读取')
  })

  it('readBodyLimited should not falsely flag truncated when body exactly reaches cap', async () => {
    let sent = false
    // 恰好读满 cap 且流正常结束 → 不应误报 truncated；
    // （此时流已被 peek-read 关闭，按规范 reader.cancel() 为合法 no-op，不触发 source.cancel）
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(512 * 1024).fill(65)) } else { c.close() } },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body: stream }) as any

    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'fetch_url')!
    const result = await tool.execute('id', { url: 'https://api.example.com/exact' }, undefined, undefined, {} as any)
    expect(result.content[0].text).toContain('AAAA')
    expect(result.content[0].text).not.toContain('已截断读取')
  })
})
