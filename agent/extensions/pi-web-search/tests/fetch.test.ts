import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('searchDirect (fetch.ts)', () => {
  it('should parse Bing HTML results', async () => {
    const mockHtml = `<html><body>
      <h2><a href="https://example.com/1">Result One</a></h2>
      <h2><a href="https://example.com/2">Result Two</a></h2>
    </body></html>`

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    })

    const { searchDirect } = await import('../fetch')
    const result = await searchDirect('test query', 2)

    expect(result).toContain('搜索: "test query"')
    expect(result).toContain('1. Result One')
    expect(result).toContain('https://example.com/1')
    expect(result).toContain('2. Result Two')
  })

  it('should handle non-ok HTTP response', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel },
    })

    const { searchDirect } = await import('../fetch')
    const result = await searchDirect('test')
    expect(result).toContain('搜索失败: HTTP 503')
    // 提前 return 前必须取消响应体，避免连接悬挂
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('should return empty message when no results found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>no links here</body></html>'),
    })

    const { searchDirect } = await import('../fetch')
    const result = await searchDirect('nothing')
    expect(result).toContain('无结果')
  })

  it('should use AbortController for timeout', async () => {
    let signal: AbortSignal | undefined
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      signal = opts?.signal
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('<html></html>'),
      })
    })

    const { searchDirect } = await import('../fetch')
    await searchDirect('test')
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(false)
  })
})
