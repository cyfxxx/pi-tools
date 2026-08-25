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

  it('审计回归：用户 abort signal 转发到内部 fetch，触发后请求中断', async () => {
    // 模拟真实 fetch：监听传入的 signal，abort 时 reject（AbortError）
    let captured: AbortSignal | undefined
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      captured = opts?.signal
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const { searchDirect } = await import('../fetch')
    const ac = new AbortController()
    const p = searchDirect('test', 5, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/abort/i)
    expect(captured!.aborted).toBe(true)
  })

  it('signal 未触发时正常返回结果（透传不改变成功路径）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><h2><a href="https://example.com/1">R</a></h2></body></html>'),
    })
    const { searchDirect } = await import('../fetch')
    const ac = new AbortController()
    const result = await searchDirect('q', 5, ac.signal)
    expect(result).toContain('搜索:')
  })
})
