import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      number_of_results: 0,
      results: [],
      answers: [],
      corrections: [],
      suggestions: [],
      unresponsive_engines: [],
      infoboxes: [],
    }),
  }) as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('search', () => {
  describe('formatResponse', () => {
    it('should return formatted results', async () => {
      const mockData = {
        number_of_results: 2,
        results: [
          { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1', engine: 'google', publishedDate: '2024-01-01' },
          { title: 'Result 2', url: 'https://example.com/2' },
        ],
        answers: [],
        corrections: [],
        suggestions: [],
        unresponsive_engines: [],
        infoboxes: [],
      }

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      }) as any

      const { searchWeb } = await import('../src/search')
      const config = { searxng_url: 'https://searx.be', timeout: 5000 }

      const result = await searchWeb(config, 'test query', undefined, undefined)

      expect(result).toContain('搜索: "test query"')
      expect(result).toContain('Result 1')
      expect(result).toContain('https://example.com/1')
      expect(result).toContain('[google]')
      expect(result).toContain('Content 1')
    })

    it('should handle empty results', async () => {
      const { searchWeb } = await import('../src/search')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number_of_results: 0,
          results: [],
          answers: [],
          corrections: [],
          suggestions: [],
          unresponsive_engines: [],
          infoboxes: [],
        }),
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'no results', undefined, undefined)

      expect(result).toContain('未找到结果。')
    })

    it('should show suggestions', async () => {
      const { searchWeb } = await import('../src/search')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          answers: [],
          corrections: [],
          suggestions: ['foo', 'bar'],
          unresponsive_engines: [],
          infoboxes: [],
        }),
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'test', undefined, undefined)

      expect(result).toContain('搜索建议')
      expect(result).toContain('foo')
      expect(result).toContain('bar')
    })

    it('should show spell corrections', async () => {
      const { searchWeb } = await import('../src/search')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          answers: [],
          corrections: ['corrected-term'],
          suggestions: [],
          unresponsive_engines: [],
          infoboxes: [],
        }),
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'test', undefined, undefined)

      expect(result).toContain('拼写纠正')
      expect(result).toContain('corrected-term')
    })

    it('should report unresponsive engines', async () => {
      const { searchWeb } = await import('../src/search')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          results: [],
          answers: [],
          corrections: [],
          suggestions: [],
          unresponsive_engines: ['google', 'bing'],
          infoboxes: [],
        }),
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'test', undefined, undefined)

      expect(result).toContain('以下引擎无响应')
      expect(result).toContain('google')
      expect(result).toContain('bing')
    })

    it('should cap results at 20 and report remaining', async () => {
      const { searchWeb } = await import('../src/search')
      const manyResults = Array.from({ length: 25 }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `https://example.com/${i + 1}`,
        content: `Content ${i + 1}`,
      }))

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          number_of_results: 25,
          results: manyResults,
          answers: [],
          corrections: [],
          suggestions: [],
          unresponsive_engines: [],
          infoboxes: [],
        }),
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'test', undefined, undefined)

      expect(result).toContain('还有 5 条结果未显示')
    })
  })

  describe('fetch error handling', () => {
    it('should handle non-ok HTTP response', async () => {
      const { searchWeb } = await import('../src/search')

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      const result = await searchWeb(config, 'test', undefined, undefined)

      expect(result).toContain('搜索失败')
      expect(result).toContain('500')
    })
  })

  describe('URL parameter construction', () => {
    it('should pass search params correctly', async () => {
      const { searchWeb } = await import('../src/search')
      let capturedUrl = ''

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            results: [],
            answers: [],
            corrections: [],
            suggestions: [],
            unresponsive_engines: [],
            infoboxes: [],
          }),
        })
      }) as any

      const config = { searxng_url: 'https://searx.be', timeout: 5000 }
      await searchWeb(config, 'hello world', {
        engines: ['google', 'bing'],
        categories: 'general',
        pageno: 2,
        time_range: 'week',
        lang: 'zh-CN',
      })

      expect(capturedUrl).toContain('q=hello+world')
      expect(capturedUrl).toContain('engines=google%2Cbing')
      expect(capturedUrl).toContain('categories=general')
      expect(capturedUrl).toContain('pageno=2')
      expect(capturedUrl).toContain('time_range=week')
      expect(capturedUrl).toContain('lang=zh-CN')
    })
  })
})
