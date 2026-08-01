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
    delete process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH
    delete process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT
    delete process.env.PI_WEB_TOOLKIT_HEADLESS
    delete process.env.PI_WEB_TOOLKIT_PROXY
    delete process.env.PI_WEB_TOOLKIT_FINGERPRINT_SEED
  })

  it('should use defaults when no config file or env', async () => {
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(false)
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

  it('should handle NaN from invalid env var', async () => {
    process.env.PI_WEB_TOOLKIT_VIEWPORT_WIDTH = 'abc'
    process.env.PI_WEB_TOOLKIT_VIEWPORT_HEIGHT = 'def'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.viewport_width).toBe(1280)
    expect(cfg.browser.viewport_height).toBe(800)
  })

  it('should reject PI_WEB_TOOLKIT_HEADLESS=false as false', async () => {
    process.env.PI_WEB_TOOLKIT_HEADLESS = 'false'
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(false)
  })

  it('should read settings from pi-browser section', async () => {
    settingsContent = JSON.stringify({
      'pi-browser': { headless: true, viewport_width: 1920 },
    })
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(true)
    expect(cfg.browser.viewport_width).toBe(1920)
  })

  it('should fall back to legacy pi-web-toolkit section', async () => {
    settingsContent = JSON.stringify({
      'pi-web-toolkit': { headless: true, proxy: 'http://1.2.3.4:8080' },
    })
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(true)
    expect(cfg.browser.proxy).toBe('http://1.2.3.4:8080')
  })

  it('should prefer pi-browser section over legacy fallback', async () => {
    settingsContent = JSON.stringify({
      'pi-web-toolkit': { headless: true },
      'pi-browser': { headless: false },
    })
    const { loadConfig } = await import('../config')
    const cfg = loadConfig()
    expect(cfg.browser.headless).toBe(false)
  })
})
