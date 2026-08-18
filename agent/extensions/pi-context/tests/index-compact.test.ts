import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDiagLines } from '../../../lib/usage-diag.ts'

// 回归：auto-compact 触发挂载点（agent_settled vs agent_end）与
// recordAutoCompact/markCompact 时机（压缩成功回调后，而非发起前）。

type Handler = (event: unknown, ctx: unknown) => unknown

interface FakePi {
  on: (name: string, h: Handler) => void
  sendMessage: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  registerTool: ReturnType<typeof vi.fn>
}

let dir: string
const ORIG_ENV = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'index-compact-'))
  process.env.PI_USAGE_DIAG_FILE = join(dir, 'diag.jsonl')
})

afterEach(() => {
  process.env = { ...ORIG_ENV }
  delete process.env.PI_USAGE_DIAG_FILE
  rmSync(dir, { recursive: true, force: true })
})

/** 每个用例用 vi.resetModules 得到全新模块实例（fresh compactDecider/gate） */
async function loadIndex(): Promise<{ handlers: Map<string, Handler[]>; pi: FakePi }> {
  vi.resetModules()
  const mod = await import('../index.ts')
  const handlers = new Map<string, Handler[]>()
  const pi: FakePi = {
    on(name: string, h: Handler) {
      const list = handlers.get(name) ?? []
      list.push(h)
      handlers.set(name, list)
    },
    sendMessage: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
  }
  mod.default(pi as never)
  return { handlers, pi }
}

function overThresholdCtx(compact: (opts: { onComplete?: () => void; onError?: (e: Error) => void }) => void) {
  return {
    getContextUsage: () => ({ tokens: 850_000, contextWindow: 1_000_000 }),
    compact,
  }
}

describe('pi-context: 压缩触发挂载点与记账时机', () => {
  it('挂载在 agent_settled 而非 agent_end（内核重试轮不被打断）', { timeout: 30_000 }, async () => {
    // AgentEndEvent 无 willRetry 字段（types.d.ts 实测），扩展无法在
    // agent_end 判断内核是否将重试；agent_settled 语义为"run 完全 settled，
    // 无重试/压缩/排队续跑"，此点触发 compact 不会 abort 内核后续动作
    // 注：本用例是文件内首次 loadIndex——冷加载真实 @earendil-works/
    // pi-coding-agent 包需 ~18s（arm64），超过 vitest 默认 5s 超时，故显式 30s
    const { handlers } = await loadIndex()
    expect(handlers.has('agent_settled')).toBe(true)
    expect(handlers.has('agent_end')).toBe(false)
  })

  it('压缩成功（onComplete）后才 recordAutoCompact + markCompact（cooldown 生效）', async () => {
    const { handlers } = await loadIndex()
    let compactOpts: { onComplete?: () => void; onError?: (e: Error) => void } | undefined
    const ctx = overThresholdCtx((opts) => {
      compactOpts = opts
    })

    handlers.get('agent_settled')![0](undefined, ctx)
    expect(compactOpts).toBeDefined()
    // 发起时尚未完成：不记账（修复前 recordAutoCompact 在 compact() 调用前执行）
    expect(loadDiagLines().filter((l) => 'type' in l)).toHaveLength(0)

    compactOpts!.onComplete!()
    const lines = loadDiagLines()
    expect(lines.some((l) => 'type' in l && l.type === 'auto-compact')).toBe(true)

    // markCompact 在成功后执行 → cooldown 生效，紧随的下一轮不再触发
    const compactAgain = vi.fn()
    handlers.get('agent_settled')![0](
      undefined,
      overThresholdCtx(compactAgain as never),
    )
    expect(compactAgain).not.toHaveBeenCalled()
  })

  it('压缩失败（onError）→ 不记账、gate disarm、不自动继续', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { handlers, pi } = await loadIndex()
      const ctx = overThresholdCtx((opts) => {
        opts.onError!(new Error('boom'))
      })

      handlers.get('agent_settled')![0](undefined, ctx)
      // 失败不 recordAutoCompact
      expect(loadDiagLines().filter((l) => 'type' in l)).toHaveLength(0)

      // gate 已 disarm：session_compact 不再触发自动继续
      handlers.get('session_compact')![0]({}, {})
      expect(pi.sendMessage).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('压缩成功后 session_compact → 注入自动继续消息', async () => {
    const { handlers, pi } = await loadIndex()
    const ctx = overThresholdCtx((opts) => {
      opts.onComplete!()
    })

    handlers.get('agent_settled')![0](undefined, ctx)
    handlers.get('session_compact')![0]({}, {})
    expect(pi.sendMessage).toHaveBeenCalledTimes(1)
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'continue-after-compact' }),
      { triggerTurn: true },
    )
  })

  it('内核无 contextWindow（getContextUsage undefined）→ turn_end 记录的 provider tokens fallback 仍触发压缩', async () => {
    const { handlers } = await loadIndex()
    // 先模拟 turn_end：provider 报告 contextTokens（input+cacheRead）
    handlers.get('turn_end')![0](
      { message: { usage: { input: 600_000, cacheRead: 250_000 } } },
      {},
    )
    // getContextUsage 返回 undefined（opencode-go provider 场景——内核
    // model.contextWindow 未配置 → 8-15 实测自动压缩从未触发的根因）
    const compact = vi.fn((opts: { onComplete?: () => void }) => opts.onComplete?.())
    handlers.get('agent_settled')![0](
      undefined,
      { getContextUsage: () => undefined, compact },
    )
    expect(compact).toHaveBeenCalledTimes(1)
    // fallback 窗口 1M × 0.8 = 800K < 850K(tokens) → 触发后记账
    const lines = loadDiagLines()
    expect(lines.some((l) => 'type' in l && l.type === 'auto-compact')).toBe(true)
  })

  it('新会话（reason=new/fork）清零跨会话残留 provider contextTokens（LOW 修复）', async () => {
    const { handlers } = await loadIndex()
    // 上一会话 turn_end 记录的大值（模块级残留）
    handlers.get('turn_end')![0](
      { message: { usage: { input: 600_000, cacheRead: 250_000 } } },
      {},
    )
    // 新会话启动：fallback 已清零 → 内核无 contextWindow 时不再按旧会话大值误触发
    const compactNew = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'new' },
      { getContextUsage: () => undefined, compact: compactNew },
    )
    expect(compactNew).not.toHaveBeenCalled()
    // fork（分叉=新会话身份）同样清零
    const compactFork = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'fork' },
      { getContextUsage: () => undefined, compact: compactFork },
    )
    expect(compactFork).not.toHaveBeenCalled()
  })

  it('恢复会话（reason=resume）保留 provider contextTokens fallback（断链恢复仍可压缩）', async () => {
    const { handlers } = await loadIndex()
    handlers.get('turn_end')![0](
      { message: { usage: { input: 600_000, cacheRead: 250_000 } } },
      {},
    )
    const compact = vi.fn((opts: { onComplete?: () => void }) => opts.onComplete?.())
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => undefined, compact },
    )
    // 850K ≥ 1M×0.4 恢复阈值 → 触发
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('溢出兜底：tokens ≥ window 时绕过阈值/cooldown 强制压缩（对齐 dsh CONTEXT_WINDOW_EXCEEDED）', async () => {
    const { handlers } = await loadIndex()
    const compact = vi.fn((opts: { onComplete?: () => void }) => opts.onComplete?.())
    // 100K cooldown 内也要强制（溢出不等待冷却）
    handlers.get('agent_settled')![0](
      undefined,
      { getContextUsage: () => ({ tokens: 5_000_000, contextWindow: 1_000_000 }), compact },
    )
    expect(compact).toHaveBeenCalledTimes(1)
    const lines = loadDiagLines()
    expect(lines.some((l) => 'type' in l && l.type === 'auto-compact')).toBe(true)

    // 溢出未发生时正常走 decider（未超阈值不压缩）
    const compact2 = vi.fn()
    handlers.get('agent_settled')![0](
      undefined,
      { getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000 }), compact: compact2 },
    )
    expect(compact2).not.toHaveBeenCalled()
  })
})
