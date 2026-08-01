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
})
