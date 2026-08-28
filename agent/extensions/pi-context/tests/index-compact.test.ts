import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDiagLines } from '../../../lib/usage-diag.ts'

// 后台任务门（2026-08-24）：mock node:child_process 的 spawnSync，供 tmux
// list-sessions 的存在性断言；默认 PI_CONTEXT_TMUX_REGISTRY 指向空文件，不触发
const childMock = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: childMock.spawnSync }))

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
  // 重启来源判定隔离：admin state 指向临时文件（真实 ~/.pi state 的残留 action 会干扰）
  process.env.PI_CONTEXT_ADMIN_STATE = join(dir, 'admin-state.json')
  // 任务门隔离：指向空目录（真实 ~/.pi/plans 残留 in_progress 会干扰断言）
  process.env.PI_CONTEXT_PLANS_DIR = join(dir, 'plans')
  // 后台任务门隔离：registry 指向不存在的临时文件（真实 ~/.pi 下 registry 会干扰）
  process.env.PI_CONTEXT_TMUX_REGISTRY = join(dir, 'tmux-reg.json')
  childMock.spawnSync.mockReset()
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

/** 模拟 pi-autopilot state 文件（恢复压缩只认 restart_hang） */
function writeAdminState(action: string): void {
  writeFileSync(
    join(dir, 'admin-state.json'),
    JSON.stringify({ action, timestamp: Date.now(), restartLog: null }),
    'utf8',
  )
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
    // 看门狗挂死重启（restart_hang）才走恢复压缩路径
    writeAdminState('restart_hang')
    handlers.get('turn_end')![0](
      { message: { usage: { input: 600_000, cacheRead: 250_000 } } },
      {},
    )
    const compact = vi.fn((opts: { onComplete?: () => void }) => opts.onComplete?.())
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => undefined, compact },
    )
    // 850K ≥ 绝对阈值 200K（用户策略；此前为 1M×0.4 恢复阈值）→ 触发
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('三重门限：最近有用户消息（离开不足 10 分钟）→ 不压缩（空闲门）', async () => {
    const { handlers } = await loadIndex()
    // context 事件：最后 user 消息是刚刚 → 空闲门不满足
    const compact = vi.fn()
    handlers.get('context')![0](
      { messages: [{ role: 'user', timestamp: Date.now() }] },
      {},
    )
    handlers.get('agent_settled')![0](
      undefined,
      overThresholdCtx(compact as never),
    )
    expect(compact).not.toHaveBeenCalled()
    // 离开 11 分钟后再触发 → 空闲门满足，压缩
    const compact2 = vi.fn()
    handlers.get('context')![0](
      { messages: [{ role: 'user', timestamp: Date.now() - 11 * 60_000 }] },
      {},
    )
    handlers.get('agent_settled')![0](
      undefined,
      overThresholdCtx(compact2 as never),
    )
    expect(compact2).toHaveBeenCalledTimes(1)
  })

  it('三重门限：计划文件中存在 in_progress 任务（plan.md [~]）→ 不压缩（任务门）', async () => {
    const { handlers } = await loadIndex()
    // 动态时间戳：写死历史时间会随 7 天窗口滚动失效（2026-08-27 实测 plan-1787200000000 距今 7.2 天被窗口过滤）
    const planDir = join(dir, 'plans', `plan-${Date.now()}`)
    mkdirSync(planDir, { recursive: true })
    writeFileSync(
      join(planDir, 'plan.md'),
      '# 计划\n- [~] 1. 进行中任务 (正在测试)\n\n<!-- nextId: 2 -->',
      'utf8',
    )
    const compact = vi.fn()
    handlers.get('agent_settled')![0](
      undefined,
      overThresholdCtx(compact as never),
    )
    expect(compact).not.toHaveBeenCalled()
  })

  it('重启场景阈值：resume 时上下文 <100K（重启阈值）→ 不压缩', async () => {
    const { handlers } = await loadIndex()
    writeAdminState('restart_hang')
    const compact = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => ({ tokens: 90_000, contextWindow: 1_000_000 }), compact },
    )
    expect(compact).not.toHaveBeenCalled()
    // 100K≤tokens<200K：重启场景触发（agent_settled 常规 200K 不触发）
    const compact2 = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_000_000 }), compact: compact2 },
    )
    expect(compact2).toHaveBeenCalledTimes(1)
  })

  it('手动重启（action=restart）与无 state：resume 超阈值也不压缩（2026-08-24 用户修正）', async () => {
    const { handlers } = await loadIndex()
    // /auto restart 写 action=restart（非看门狗）→ 恢复压缩不生效，留给 agent_settled 常规门限
    writeAdminState('restart')
    let compact = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_000_000 }), compact },
    )
    expect(compact).not.toHaveBeenCalled()
    // 无 state 文件（冷启动异常/文件损坏同此路径）→ 同样不压缩
    rmSync(join(dir, 'admin-state.json'), { force: true })
    const compact2 = vi.fn()
    handlers.get('session_start')![0](
      { reason: 'resume' },
      { getContextUsage: () => ({ tokens: 850_000, contextWindow: 1_000_000 }), compact: compact2 },
    )
    expect(compact2).not.toHaveBeenCalled()
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

  it('M4：历史/旧会话遗留 in_progress（非最新目录）不再阻塞压缩', async () => {
    const { handlers } = await loadIndex()
    // 旧目录（ts 较小，超过 7 天窗口被过滤）含进行中步骤——修复前的遍历会因它阻塞
    // 动态时间戳：写死历史时间会随 7 天窗口滚动失效（08-27/08-28 两次实测）
    const oldDir = join(dir, 'plans', `plan-${Date.now() - 8 * 24 * 3600e3}`)
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'plan.md'), '# 计划\n- [~] 1. 旧任务 (正在跑)\n', 'utf8')
    // 最新目录无进行中任务
    const newDir = join(dir, 'plans', `plan-${Date.now()}`)
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'plan.md'), '# 计划\n- [ ] 1. 待办\n', 'utf8')
    const compact = vi.fn()
    handlers.get('agent_settled')![0](undefined, overThresholdCtx(compact as never))
    expect(compact).toHaveBeenCalled()
  })

  it('M4：最新目录含 in_progress → 仍阻塞压缩', async () => {
    const { handlers } = await loadIndex()
    // 最新目录含进行中任务（应阻塞，与单一目录旧行为一致）；动态时间戳避 7 天窗口失效
    const newDir = join(dir, 'plans', `plan-${Date.now()}`)
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, 'plan.md'), '# 计划\n- [~] 1. 新任务 (正在跑)\n', 'utf8')
    const compact = vi.fn()
    handlers.get('agent_settled')![0](undefined, overThresholdCtx(compact as never))
    expect(compact).not.toHaveBeenCalled()
  })

  it('阈值默认 256K（2026-08-24 用户策略）：255K 不压、260K 任务/空闲满足即压', async () => {
    const { handlers } = await loadIndex()
    // 255K < 256K 默认绝对阈值 → under-threshold
    const compact = vi.fn()
    handlers.get('agent_settled')![0](
      undefined,
      { getContextUsage: () => ({ tokens: 255_000, contextWindow: 1_000_000 }), compact } as never,
    )
    expect(compact).not.toHaveBeenCalled()
    // 260K > 256K，plans 空（无任务）+ registry 空（无后台任务）+ lastUserTs=0 → 压
    const compact2 = vi.fn()
    handlers.get('agent_settled')![0](
      undefined,
      { getContextUsage: () => ({ tokens: 260_000, contextWindow: 1_000_000 }), compact: compact2 } as never,
    )
    expect(compact2).toHaveBeenCalledTimes(1)
  })

  it('后台任务门：本会话 registry 有存活 tmux 会话 → 阻塞压缩；会话退出 → 恢复（2026-08-24）', async () => {
    // 显式固定会话 id：tmux 等派生子进程可能不带 PI_SESSION_ID，缺省时后台检测宽容放行会
    // 破坏断言（产品中 pi-tmux 写 owner 与 pi-context 读 owner 同一进程同 env，缺省同时缺失、自洽）
    process.env.PI_SESSION_ID = 'test-session'
    const owner = 'test-session'
    writeFileSync(
      join(dir, 'tmux-reg.json'),
      JSON.stringify({
        sessions: {
          'pi-bgtest': {
            name: 'pi-bgtest',
            logPath: '/tmp/x.log',
            command: 'sleep 300',
            createdAt: new Date().toISOString(),
            owner,
          },
        },
      }),
      'utf8',
    )
    const { handlers } = await loadIndex()
    // tmux 报告该会话存活 → 有后台任务 → 不压
    childMock.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'pi-bgtest: 1 windows (created ...) (detached)\n',
      stderr: '',
    })
    const c1 = vi.fn()
    handlers.get('agent_settled')![0](undefined, overThresholdCtx(c1 as never))
    expect(c1).not.toHaveBeenCalled()
    // tmux 已无该会话（仅他会话）→ 无后台任务 → 压
    childMock.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'pi-other: 1 windows (created ...)\n',
      stderr: '',
    })
    const c2 = vi.fn()
    handlers.get('agent_settled')![0](undefined, overThresholdCtx(c2 as never))
    expect(c2).toHaveBeenCalledTimes(1)
  })

  it('任务完成窗：in_progress→全部完成 后 10 分钟内不压，满 10 分钟压（2026-08-24）', async () => {
    vi.useFakeTimers()
    try {
      const { handlers } = await loadIndex()
      const planDir = join(dir, 'plans', `plan-${Date.now()}`)
      mkdirSync(planDir, { recursive: true })
      // 阶段1：有 in_progress → 任务门阻塞
      writeFileSync(join(planDir, 'plan.md'), '# 计划\n- [~] 1. 进行中 (跑)\n', 'utf8')
      const c1 = vi.fn()
      handlers.get('agent_settled')![0](undefined, overThresholdCtx(c1 as never))
      expect(c1).not.toHaveBeenCalled()
      // 阶段2：任务全部完成 → 打点 taskDoneAt，10min 内不压
      writeFileSync(join(planDir, 'plan.md'), '# 计划\n- [x] 1. 完成\n', 'utf8')
      const c2 = vi.fn()
      handlers.get('agent_settled')![0](undefined, overThresholdCtx(c2 as never))
      expect(c2).not.toHaveBeenCalled()
      // 阶段3：推进 11 分钟 → 空闲窗满足 → 压
      vi.advanceTimersByTime(11 * 60_000)
      const c3 = vi.fn()
      handlers.get('agent_settled')![0](undefined, overThresholdCtx(c3 as never))
      expect(c3).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
