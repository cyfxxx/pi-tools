import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerCommands } from '../commands'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

// Mock fs module
let modesContent: string | null = null
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

describe('commands', () => {
  let mockPi: ExtensionAPI
  let mockCtx: ExtensionCommandContext
  let commandHandler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>
  let registeredCommand: string | null = null

  beforeEach(() => {
    modesContent = null
    registeredCommand = null
    
    mockPi = {
      registerCommand: (name: string, options: any) => {
        registeredCommand = name
        commandHandler = options.handler
      },
      on: vi.fn(),
    } as any
    
    mockCtx = {
      ui: {
        notify: vi.fn(),
        confirm: vi.fn(),
        select: vi.fn(),
        input: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
    } as any
  })

  it('should register mode command', () => {
    registerCommands(mockPi)
    expect(registeredCommand).toBe('mode')
  })

  it('should show help when asked', async () => {
    registerCommands(mockPi)
    await commandHandler('help', mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('用法:'),
      'info'
    )
  })

  it('should list modes', async () => {
    registerCommands(mockPi)
    await commandHandler('list', mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('可用模式:'),
      'info'
    )
  })

  it('should show current mode when no args', async () => {
    registerCommands(mockPi)
    await commandHandler('', mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('当前模式:'),
      'info'
    )
  })

  it('should show error for unknown mode', async () => {
    registerCommands(mockPi)
    await commandHandler('unknown', mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('未知模式:'),
      'error'
    )
  })

  it('should switch to valid mode', async () => {
    // First, create a modes file with light mode
    modesContent = JSON.stringify({
      default: 'full',
      current: 'full',
      modes: {
        full: {
          description: '完整模式',
          extensions: [],
          skills: [],
          systemPrompt: null,
          appendSystemPrompt: null,
          thinking: null,
        },
        light: {
          description: '轻量模式',
          extensions: ['pi-web-search'],
          skills: [],
          systemPrompt: null,
          appendSystemPrompt: null,
          thinking: 'low',
        },
      },
    })
    
    registerCommands(mockPi)
    await commandHandler('light', mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('已切换到模式: light'),
      'info'
    )
  })
})