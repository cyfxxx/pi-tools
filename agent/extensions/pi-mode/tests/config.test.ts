import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('modes.json')) return modesContent != null
      return actual.existsSync(p)
    },
    readFileSync: (p: string, ...args: any[]) => {
      if (p.includes('modes.json') && modesContent != null) return modesContent
      return actual.readFileSync(p, ...args)
    },
    writeFileSync: (p: string, data: string, ...args: any[]) => {
      if (p.includes('modes.json')) {
        modesContent = data
        return
      }
      return actual.writeFileSync(p, data, ...args)
    },
    mkdirSync: () => {},
  }
})

let modesContent: string | null = null

describe('config', () => {
  beforeEach(() => {
    modesContent = null
  })

  it('should load default modes when no config file', async () => {
    const { loadModes } = await import('../config')
    const modes = loadModes()
    expect(modes.default).toBe('full')
    expect(modes.current).toBe('full')
    expect(modes.modes.full).toBeDefined()
    expect(modes.modes.full.description).toContain('完整模式')
  })

  it('should get current mode', async () => {
    const { getCurrentMode } = await import('../config')
    const mode = getCurrentMode()
    expect(mode).toBe('full')
  })

  it('should get mode config', async () => {
    const { getModeConfig } = await import('../config')
    const config = getModeConfig('full')
    expect(config).toBeDefined()
    expect(config?.description).toContain('完整模式')
  })

  it('should return null for unknown mode', async () => {
    const { getModeConfig } = await import('../config')
    const config = getModeConfig('unknown')
    expect(config).toBeNull()
  })

  it('should list mode names', async () => {
    const { listModeNames } = await import('../config')
    const names = listModeNames()
    expect(names).toContain('full')
  })

  it('should get default mode', async () => {
    const { getDefaultMode } = await import('../config')
    const defaultMode = getDefaultMode()
    expect(defaultMode).toBe('full')
  })

  it('should set current mode', async () => {
    const { setCurrentMode, getCurrentMode } = await import('../config')
    setCurrentMode('light')
    const mode = getCurrentMode()
    expect(mode).toBe('light')
  })

  it('should save and load modes', async () => {
    const { loadModes, saveModes } = await import('../config')
    const modes = loadModes()
    modes.modes.light = {
      description: '轻量模式',
      extensions: ['pi-web-search'],
      skills: [],
      systemPrompt: null,
      appendSystemPrompt: null,
      thinking: 'low',
    }
    saveModes(modes)
    
    const loadedModes = loadModes()
    expect(loadedModes.modes.light).toBeDefined()
    expect(loadedModes.modes.light.description).toBe('轻量模式')
  })
})