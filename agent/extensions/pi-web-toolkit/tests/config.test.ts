import { describe, it, expect, beforeEach, vi } from 'vitest'

// Prevent config from reading the real settings file
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('settings.json')) return false
      return actual.existsSync(p)
    },
  }
})

describe('config', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.PI_WEB_TOOLKIT_SEARXNG_URL
    delete process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT
    delete process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH
    delete process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT
    delete process.env.PI_WEB_TOOLKIT_HEADLESS
    delete process.env.PI_WEB_TOOLKIT_PROXY
    delete process.env.PI_WEB_TOOLKIT_FINGERPRINT_SEED
  })

  it('should use defaults when no config file or env', async () => {
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.searxng_url).toBe('https://searx.be')
    expect(cfg.search.timeout).toBe(15000)
    expect(cfg.browser.headless).toBe(false)
    expect(cfg.browser.viewport_width).toBe(1280)
    expect(cfg.browser.viewport_height).toBe(800)
    expect(cfg.proxy_pool).toBeUndefined()
  })

  it('should read search env vars', async () => {
    process.env.PI_WEB_TOOLKIT_SEARXNG_URL = 'https://my-searxng.local'
    process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT = '5000'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.searxng_url).toBe('https://my-searxng.local')
    expect(cfg.search.timeout).toBe(5000)
  })

  it('should handle NaN from invalid env var (M4)', async () => {
    process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT = 'not-a-number'
    process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH = 'abc'
    process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT = 'def'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.timeout).toBe(15000)
    expect(cfg.browser.viewport_width).toBe(1280)
    expect(cfg.browser.viewport_height).toBe(800)
  })

  it('should merge env over defaults', async () => {
    process.env.PI_WEB_TOOLKIT_HEADLESS = 'true'
    process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH = '1920'
    process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT = '1080'
    process.env.PI_WEB_TOOLKIT_FINGERPRINT_SEED = 'test-seed'
    process.env.PI_WEB_TOOLKIT_PROXY = 'http://1.2.3.4:8080'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(true)
    expect(cfg.browser.viewport_width).toBe(1920)
    expect(cfg.browser.viewport_height).toBe(1080)
    expect(cfg.browser.fingerprint_seed).toBe('test-seed')
    expect(cfg.browser.proxy).toBe('http://1.2.3.4:8080')
  })

  it('should reject PI_WEB_TOOLKIT_HEADLESS=false as false', async () => {
    process.env.PI_WEB_TOOLKIT_HEADLESS = 'false'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(false)
  })

  it('should set headless true when env is true', async () => {
    process.env.PI_WEB_TOOLKIT_HEADLESS = 'true'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(true)
  })
})
