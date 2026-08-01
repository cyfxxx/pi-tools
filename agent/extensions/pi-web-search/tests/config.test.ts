import { describe, it, expect, beforeEach, vi } from 'vitest'

// Prevent config from reading the real settings file
let settingsContent: string | null = null
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('settings.json')) return settingsContent != null
      return actual.existsSync(p)
    },
    readFileSync: (p: string, ...args: any[]) => {
      if (p.includes('settings.json') && settingsContent != null) return settingsContent
      return actual.readFileSync(p, ...args)
    },
  }
})

describe('config', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    settingsContent = null
    process.env = { ...OLD_ENV }
    delete process.env.PI_WEB_TOOLKIT_SEARXNG_URL
    delete process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT
  })

  it('should use defaults when no config file or env', async () => {
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.searxng_url).toBe('https://searx.be')
    expect(cfg.search.timeout).toBe(15000)
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
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.timeout).toBe(15000)
  })

  it('should read settings from pi-web-search section', async () => {
    settingsContent = JSON.stringify({
      'pi-web-search': { searxng_url: 'http://127.0.0.1:8889', search_timeout: 20000 },
    })
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.searxng_url).toBe('http://127.0.0.1:8889')
    expect(cfg.search.timeout).toBe(20000)
  })

  it('should fall back to legacy pi-web-toolkit section', async () => {
    settingsContent = JSON.stringify({
      'pi-web-toolkit': { searxng_url: 'http://legacy.local:8889' },
    })
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.search.searxng_url).toBe('http://legacy.local:8889')
  })
})
