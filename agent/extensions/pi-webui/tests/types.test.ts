import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock fs to control config loading
let configContent: string | null = null
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('webui/config.json')) return configContent != null
      return actual.existsSync(p)
    },
    readFileSync: (p: string, ...args: any[]) => {
      if (p.includes('webui/config.json') && configContent != null) return configContent
      return actual.readFileSync(p, ...args)
    },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

// Mock os
vi.mock('os', () => ({
  homedir: () => '/home/testuser',
}))

describe('pi-webui types & config', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    configContent = null
    process.env = { ...OLD_ENV }
  })

  it('should use DEFAULT_CONFIG when no config file exists', async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import('../index')
    const cfg = loadConfig()
    expect(cfg.port).toBe(3100)
    expect(cfg.host).toBe('0.0.0.0')
    expect(typeof cfg.authToken).toBe('string')
    expect(cfg.authToken.length).toBe(32)
    expect(cfg.maxMessageHistory).toBe(1000)
    expect(cfg.enableFileUpload).toBe(false)
  })

  it('should read config from file', async () => {
    configContent = JSON.stringify({
      port: 4000,
      host: '127.0.0.1',
      authToken: 'custom-token-123',
      maxMessageHistory: 1000,
      enableFileUpload: true,
      uploadDir: '/custom/uploads',
    })
    const { loadConfig } = await import('../index')
    const cfg = loadConfig()
    expect(cfg.port).toBe(4000)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.authToken).toBe('custom-token-123')
    expect(cfg.maxMessageHistory).toBe(1000)
    expect(cfg.enableFileUpload).toBe(true)
    expect(cfg.uploadDir).toBe('/custom/uploads')
  })

  it('should generate authToken if missing in config', async () => {
    configContent = JSON.stringify({
      port: 4000,
    })
    const { loadConfig } = await import('../index')
    const cfg = loadConfig()
    expect(typeof cfg.authToken).toBe('string')
    expect(cfg.authToken.length).toBe(32)
  })

  it('should validate ChatMessage type structure', async () => {
    // Just ensure types compile correctly
    const msg: import('../types').ChatMessage = {
      id: 'test-id',
      ts: Date.now(),
      sender: 'user',
      senderDevice: 'device1',
      content: 'Hello',
      target: 'device2',
      type: 'text',
    }
    expect(msg.id).toBe('test-id')
    expect(msg.target).toBe('device2')
  })
})

describe('nanoid', () => {
  it('generates unique ids of specified length', async () => {
    const { nanoid } = await import('../index')
    const id1 = nanoid(16)
    const id2 = nanoid(16)
    expect(id1).toHaveLength(16)
    expect(id2).toHaveLength(16)
    expect(id1).not.toBe(id2)
  })

  it('generates default length when not specified', async () => {
    const { nanoid } = await import('../index')
    const id = nanoid()
    expect(id).toHaveLength(21) // nanoid default
  })
})