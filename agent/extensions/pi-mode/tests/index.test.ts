import { describe, it, expect, beforeEach, vi } from 'vitest'
import piModeExtension from '../index'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

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

describe('pi-mode extension', () => {
  let mockPi: ExtensionAPI
  let sessionStartHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>

  beforeEach(() => {
    modesContent = null
    sessionStartHandler = undefined as any
    
    mockPi = {
      registerCommand: vi.fn(),
      on: (event: string, handler: any) => {
        if (event === 'session_start') {
          sessionStartHandler = handler
        }
      },
    } as any
  })

  it('should register mode command', () => {
    piModeExtension(mockPi)
    expect(mockPi.registerCommand).toHaveBeenCalledWith('mode', expect.any(Object))
  })

  it('should not show notification for full mode', async () => {
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
      },
    })
    
    const mockCtx = {
      hasUI: true,
      ui: {
        notify: vi.fn(),
      },
    } as any
    
    piModeExtension(mockPi)
    await sessionStartHandler({}, mockCtx)
    expect(mockCtx.ui.notify).not.toHaveBeenCalled()
  })

  it('should show notification for non-full mode', async () => {
    modesContent = JSON.stringify({
      default: 'full',
      current: 'light',
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
    
    const mockCtx = {
      hasUI: true,
      ui: {
        notify: vi.fn(),
      },
    } as any
    
    piModeExtension(mockPi)
    await sessionStartHandler({}, mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('[模式] light:'),
      'info'
    )
  })

  it('should not show notification when hasUI is false', async () => {
    modesContent = JSON.stringify({
      default: 'full',
      current: 'light',
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
    
    const mockCtx = {
      hasUI: false,
      ui: {
        notify: vi.fn(),
      },
    } as any
    
    piModeExtension(mockPi)
    await sessionStartHandler({}, mockCtx)
    expect(mockCtx.ui.notify).not.toHaveBeenCalled()
  })

  it('should use environment mode when set', async () => {
    process.env.PI_AGENT_MODE = 'quick'
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
        quick: {
          description: '极简模式',
          extensions: [],
          skills: [],
          systemPrompt: null,
          appendSystemPrompt: null,
          thinking: null,
        },
      },
    })
    
    const mockCtx = {
      hasUI: true,
      ui: {
        notify: vi.fn(),
      },
    } as any
    
    piModeExtension(mockPi)
    await sessionStartHandler({}, mockCtx)
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('[模式] quick:'),
      'info'
    )
    
    delete process.env.PI_AGENT_MODE
  })
})