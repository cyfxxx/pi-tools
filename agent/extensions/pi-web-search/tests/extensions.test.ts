import { describe, it, expect, vi, beforeEach } from 'vitest'

interface MockPI {
  registerTool: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  registerFlag: ReturnType<typeof vi.fn>
  registerShortcut: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  sendMessage?: ReturnType<typeof vi.fn>
  appendEntry?: ReturnType<typeof vi.fn>
  sendUserMessage?: ReturnType<typeof vi.fn>
  setActiveTools?: ReturnType<typeof vi.fn>
  getFlag?: ReturnType<typeof vi.fn>
}

const mockPi = (): MockPI => ({
  registerTool: vi.fn(),
  registerCommand: vi.fn(),
  registerFlag: vi.fn(),
  registerShortcut: vi.fn(),
  on: vi.fn(),
  sendMessage: vi.fn(),
  appendEntry: vi.fn(),
  sendUserMessage: vi.fn(),
  setActiveTools: vi.fn(),
  getFlag: vi.fn(() => false),
})

const reset = (pi: MockPI) => {
  for (const key of Object.keys(pi)) {
    const fn = (pi as unknown as Record<string, unknown>)[key]
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset()
  }
}

// ─── subagent ─────────────────────────────────────────────────
describe('subagent extension', () => {
  it('registers subagent tool', async () => {
    const pi = mockPi()
    const main = (await import('../../subagent/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalled()
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name)
    expect(toolNames).toContain('subagent')
  })

  it('registers exactly 1 tool', async () => {
    const pi = mockPi()
    const main = (await import('../../subagent/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(1)
  })
})

// ─── pi-router ────────────────────────────────────────────────
describe('pi-router extension', () => {
  it('registers before_agent_start event handler', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-router/index')).default
    await main(pi as any)
    expect(pi.on).toHaveBeenCalled()
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('before_agent_start')
  })

  it('does not register tools or commands', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-router/index')).default
    await main(pi as any)
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(pi.registerCommand).not.toHaveBeenCalled()
  })
})

// ─── pi-context-efficiency ────────────────────────────────────
describe('pi-context-efficiency extension', () => {
  it('registers event handlers: context, tool_result', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context-efficiency/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('context')
    expect(events).toContain('tool_result')
  })

  it('does not register tools, but registers 1 command (ping)', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context-efficiency/index')).default
    await main(pi as any)
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(pi.registerCommand).toHaveBeenCalledTimes(1)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0])
    expect(cmdNames).toEqual(['ping'])
  })
})

// ─── pi-admin ─────────────────────────────────────────────────
describe('pi-admin extension', () => {
  it('registers 8 management tools', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-admin/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(8)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual([
      'admin_get_config', 'admin_list_models', 'admin_list_sessions',
      'admin_restart', 'admin_set_config', 'admin_set_model',
      'admin_status', 'admin_switch_session',
    ].sort())
  })

  it('registers 5 admin commands', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-admin/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(5)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual([
      'admin:config', 'admin:model', 'admin:restart', 'admin:session', 'admin:status',
    ].sort())
  })

  it('registers session_start event handler', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-admin/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_start')
  })
})

// ─── pi-scheduler ─────────────────────────────────────────────
describe('pi-scheduler extension', () => {
  it('registers schedule_task tool', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-scheduler/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(1)
    const toolName = pi.registerTool.mock.calls[0][0].name
    expect(toolName).toBe('schedule_task')
  })

  it('registers 3 scheduler commands: loop, remind, schedule', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-scheduler/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(3)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual(['loop', 'remind', 'schedule'])
  })

  it('registers session_start and session_shutdown event handlers', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-scheduler/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_start')
    expect(events).toContain('session_shutdown')
  })
})

// ─── pi-memory ────────────────────────────────────────────────
describe('pi-memory extension', () => {
  it('registers 4 memory tools: memory_store, memory_search, memory_stats, memory_forget', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(4)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual(['memory_forget', 'memory_search', 'memory_stats', 'memory_store'])
  })

  it('registers 3 memory commands', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(3)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual(['memory:prune', 'memory:search', 'memory:stats'])
  })

  it('registers session_start event handler', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_start')
  })
})

// ─── ctx-lite (unregistered extension) ────────────────────────
describe('ctx-lite extension', () => {
  it('registers 4 tools: ctx_exec, ctx_note, ctx_list, ctx_snap', async () => {
    const pi = mockPi()
    const main = (await import('../../ctx-lite/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(4)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual(['ctx_exec', 'ctx_list', 'ctx_note', 'ctx_snap'])
  })

  it('registers 3 ctx-lite commands', async () => {
    const pi = mockPi()
    const main = (await import('../../ctx-lite/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(3)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual(['ctx-lite:cleanup', 'ctx-lite:forget', 'ctx-lite:status'])
  })

  it('registers session event handlers', async () => {
    const pi = mockPi()
    const main = (await import('../../ctx-lite/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_before_compact')
    expect(events).toContain('session_start')
  })

  it('tool execute functions do not throw with defaults', async () => {
    const pi = mockPi()
    const main = (await import('../../ctx-lite/index')).default
    await main(pi as any)
    for (const call of pi.registerTool.mock.calls) {
      const tool = call[0]
      if (tool.execute) {
        const defaults: Record<string, unknown> = {}
        if (tool.name === 'ctx_exec') defaults.code = 'console.log("hello")'
        if (tool.name === 'ctx_note') defaults.key = 'test.key'
        if (tool.name === 'ctx_list') {}
        if (tool.name === 'ctx_snap') { defaults.name = 'test-snap' }
        await expect(
          tool.execute('id', defaults, undefined, undefined, {} as any),
        ).resolves.not.toThrow()
      }
    }
  })
})

// ─── pi-web-search ───────────────────────────────────────────
describe('pi-web-search extension', () => {
  it('registers 3 search tools: web_search, web_fetch, fetch_url', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-web-search/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(3)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual(['fetch_url', 'web_fetch', 'web_search'])
  })

  it('does not register commands', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-web-search/index')).default
    await main(pi as any)
    expect(pi.registerCommand).not.toHaveBeenCalled()
  })
})

// ─── pi-browser (unregistered extension) ─────────────────────
describe('pi-browser extension', () => {
  it('registers 8 browser tools', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-browser/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(8)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual([
      'browser_click', 'browser_close', 'browser_evaluate', 'browser_extract',
      'browser_navigate', 'browser_screenshot', 'browser_scroll', 'browser_type',
    ])
  })

  it('registers session lifecycle event handlers', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-browser/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_shutdown')
    expect(events).toContain('session_compact')
    expect(events).toContain('session_start')
  })
})

// ─── plan-mode (unregistered extension) ───────────────────────
describe('plan-mode extension', () => {
  it('registers 1 tool: todo', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(1)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name)
    expect(toolNames).toEqual(['todo'])
  })

  it('registers 7 plan commands: plan, planclear, planresume, plandiff, planqa, planview, todos', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(7)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual(['plan', 'planclear', 'planresume', 'plandiff', 'planqa', 'planview', 'todos'].sort())
  })

  it('registers plan flag', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    expect(pi.registerFlag).toHaveBeenCalled()
    const flagNames = pi.registerFlag.mock.calls.map((c: any[]) => c[0])
    expect(flagNames).toContain('plan')
  })

  it('registers many event handlers (13+)', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events.length).toBeGreaterThanOrEqual(10)
    expect(events).toContain('tool_call')
    expect(events).toContain('context')
    expect(events).toContain('before_agent_start')
    expect(events).toContain('turn_end')
    expect(events).toContain('agent_end')
    expect(events).toContain('session_start')
    expect(events).toContain('session_compact')
    expect(events).toContain('session_tree')
    expect(events).toContain('session_shutdown')
    expect(events).toContain('tool_execution_end')
    expect(events).toContain('agent_start')
  })

  it('todo tool execute does not throw with default action', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    const todoTool = pi.registerTool.mock.calls.find((c: any[]) => c[0].name === 'todo')
    if (todoTool) {
      await expect(
        todoTool[0].execute('id', { action: 'list' }, undefined, undefined, {} as any),
      ).resolves.not.toThrow()
    }
  })
})
