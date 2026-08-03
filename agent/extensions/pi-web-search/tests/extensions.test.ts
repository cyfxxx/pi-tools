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

// ─── pi-context（已融合 pi-router） ────────────────
describe('pi-context extension', () => {
  it('registers event handlers: context, tool_result, before_agent_start', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('context')
    expect(events).toContain('tool_result')
    expect(events).toContain('before_agent_start')
  })

  it('does not register tools or commands', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context/index')).default
    await main(pi as any)
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(pi.registerCommand).not.toHaveBeenCalled()
  })

  it('before_agent_start does not change systemPrompt when context is idle (cache-friendly)', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context/index')).default
    await main(pi as any)
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === 'before_agent_start')?.[1]
    expect(handler).toBeDefined()

    const ctx = {
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 128_000, percent: 8 }),
    }
    const result = await handler(
      { systemPrompt: 'BASE PROMPT' },
      ctx,
    )
    expect(result).toBeDefined()
    expect(result.systemPrompt).toContain('BASE PROMPT')
    expect(result.systemPrompt).toContain('Proactive Delegation')
    // 低压力：不注入压力行
    expect(result.systemPrompt).not.toContain('上下文压力')
    // 无时间戳/无精确数值 → 同一状态两次调用输出一致
    const result2 = await handler({ systemPrompt: 'BASE PROMPT' }, ctx)
    expect(result2.systemPrompt).toBe(result.systemPrompt)
  })

  it('before_agent_start injects fixed pressure hint only at high usage', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context/index')).default
    await main(pi as any)
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === 'before_agent_start')?.[1]

    const low = await handler(
      { systemPrompt: 'BASE' },
      { getContextUsage: () => ({ tokens: 50_000, contextWindow: 128_000, percent: 39 }) },
    )
    expect(low.systemPrompt).not.toContain('上下文压力')

    const high = await handler(
      { systemPrompt: 'BASE' },
      { getContextUsage: () => ({ tokens: 110_000, contextWindow: 128_000, percent: 86 }) },
    )
    expect(high.systemPrompt).toContain('上下文压力较高')

    // 档位文案固定：同一状态两次调用逐字节一致（无轮次动态数值）
    const high2 = await handler(
      { systemPrompt: 'BASE' },
      { getContextUsage: () => ({ tokens: 110_000, contextWindow: 128_000, percent: 86 }) },
    )
    expect(high2.systemPrompt).toBe(high.systemPrompt)
    expect(high.systemPrompt).not.toMatch(/toLocaleString|当前占用/)

    const crit = await handler(
      { systemPrompt: 'BASE' },
      { getContextUsage: () => ({ tokens: 123_000, contextWindow: 128_000, percent: 96 }) },
    )
    expect(crit.systemPrompt).toContain('接近满')
  })

  it('handles missing context usage gracefully (no injection)', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-context/index')).default
    await main(pi as any)
    const handler = pi.on.mock.calls.find((c: any[]) => c[0] === 'before_agent_start')?.[1]
    const result = await handler({ systemPrompt: 'BASE' }, { getContextUsage: () => undefined })
    expect(result.systemPrompt).toContain('Proactive Delegation')
    expect(result.systemPrompt).not.toContain('上下文压力')
  })
})

// ─── pi-autopilot (融合 pi-admin + pi-scheduler) ──────────────
describe('pi-autopilot extension', () => {
  it('registers 13 tools: 8 admin_* + 4 autopilot_* + schedule_task', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-autopilot/index')).default
    await main(pi as any)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual([
      'admin_get_config', 'admin_list_models', 'admin_list_sessions',
      'admin_restart', 'admin_set_config', 'admin_set_model',
      'admin_status', 'admin_switch_session',
      'autopilot_failover', 'autopilot_policy', 'autopilot_stats', 'autopilot_status',
      'schedule_task',
    ].sort())
  })

  it('registers 7 commands: auto:* + admin:restart + schedule', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-autopilot/index')).default
    await main(pi as any)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual([
      'admin:restart',
      'auto:failover', 'auto:pause', 'auto:policy', 'auto:resume', 'auto:status',
      'schedule',
    ].sort())
  })

  it('registers session_start and session_shutdown event handlers', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-autopilot/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_start')
    expect(events).toContain('session_shutdown')
  })
})

// ─── pi-memory（合并 ctx-lite 后） ───────────────────────────
describe('pi-memory extension', () => {
  it('registers 9 tools: memory_* + ctx_* (merged from ctx-lite)', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    expect(pi.registerTool).toHaveBeenCalledTimes(9)
    const toolNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name).sort()
    expect(toolNames).toEqual([
      'ctx_exec', 'ctx_list', 'ctx_note', 'ctx_snap',
      'memory_forget', 'memory_recall', 'memory_search', 'memory_stats', 'memory_store',
    ])
  })

  it('registers 1 command: memory', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(1)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0])
    expect(cmdNames).toEqual(['memory'])
  })

  it('registers lifecycle event handlers', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    const events = pi.on.mock.calls.map((c: any[]) => c[0])
    expect(events).toContain('session_start')
    expect(events).toContain('session_before_compact')
    expect(events).toContain('session_shutdown')
    expect(events).toContain('before_agent_start')
  })

  it('tool execute functions do not throw with defaults', async () => {
    const pi = mockPi()
    const main = (await import('../../pi-memory/index')).default
    await main(pi as any)
    for (const call of pi.registerTool.mock.calls) {
      const tool = call[0]
      if (!tool.execute) continue
      const defaults: Record<string, unknown> = {}
      if (tool.name === 'ctx_exec') defaults.code = 'console.log("hello")'
      if (tool.name === 'ctx_note') defaults.key = 'test.key'
      if (tool.name === 'ctx_list') {}
      if (tool.name === 'ctx_snap') defaults.name = 'test-snap'
      if (tool.name === 'memory_store') {
        defaults.category = 'fact'
        defaults.title = 'test'
        defaults.content = 'content'
      }
      await expect(
        tool.execute('id', defaults, undefined, undefined, {} as any),
      ).resolves.not.toThrow()
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

  it('registers 5 plan commands: plan, planclear, planresume, planview, todos', async () => {
    const pi = mockPi()
    const main = (await import('../../plan-mode/index')).default
    await main(pi as any)
    expect(pi.registerCommand).toHaveBeenCalledTimes(5)
    const cmdNames = pi.registerCommand.mock.calls.map((c: any[]) => c[0]).sort()
    expect(cmdNames).toEqual(['plan', 'planclear', 'planresume', 'planview', 'todos'].sort())
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
