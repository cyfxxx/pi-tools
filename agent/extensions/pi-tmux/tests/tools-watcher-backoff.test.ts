/**
 * 回归（审计 2026-08）：watcher hasSession 首次探测失败路径此前不缓存 opts——
 * tmux 长期不可用时每 5s 无限 re-spawn tmux -V。修复：负缓存 + 指数退避
 * （30s 基准 ×2^n，封顶 10min），且窗口内恒判存活——「探测失败≠会话结束」
 * 语义保持：失败绝不缓存成可判 gone 的状态，恢复后三态探测照常工作。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerTmuxTools, PROBE_BACKOFF_BASE_MS, probeBackoffMs } from '../tools.ts'
import { POLL_INTERVAL_MS, MERGE_WINDOW_MS } from '../watcher.ts'
import { runTmux, probeSession } from '../core'
import type { TmuxConfig } from '../config'

vi.mock('../core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core')>()
  return {
    ...actual,
    runTmux: vi.fn(),
    probeSession: vi.fn(),
  }
})

const CFG: TmuxConfig = { bin: 'tmux', prefix: 'pi-', logDir: '/logs', defaultLines: 100, defaultTimeoutSec: 120 }

function makeApi(notify: (text: string) => Promise<void>): Parameters<typeof registerTmuxTools>[0] {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    on: vi.fn(),
    sendMessage: notify,
  } as unknown as Parameters<typeof registerTmuxTools>[0]
}

describe('watcher 探测负缓存 + 指数退避（tmux 长期不可用）', () => {
  let notify: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(runTmux).mockReset()
    vi.mocked(probeSession).mockReset()
    notify = vi.fn().mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('连续失败按指数退避 re-spawn tmux -V，不再每 5s 无限重试；期间恒判存活不触发通知', async () => {
    vi.mocked(runTmux).mockResolvedValue({ code: 127, stdout: '', stderr: 'tmux: command not found' })
    const w = registerTmuxTools(makeApi(notify), CFG)
    w.watch('pi-dead-tmux', '/logs/pi-dead-tmux.log', true)

    const step = (ms: number) => vi.advanceTimersByTimeAsync(ms)

    await step(POLL_INTERVAL_MS) // t=5s：首次探测 → 失败 #1，进入 30s 负缓存
    expect(runTmux).toHaveBeenCalledTimes(1)
    await step(POLL_INTERVAL_MS * 5) // t=30s：窗口内（<30s），0 次 re-spawn
    expect(runTmux).toHaveBeenCalledTimes(1)
    await step(POLL_INTERVAL_MS) // t=35s：窗口过 → 失败 #2，退避翻倍至 60s
    expect(runTmux).toHaveBeenCalledTimes(2)
    await step(POLL_INTERVAL_MS * 11) // t=90s：<60s 窗口内，0 次
    expect(runTmux).toHaveBeenCalledTimes(2)
    await step(POLL_INTERVAL_MS) // t=95s：→ 失败 #3，退避 120s
    expect(runTmux).toHaveBeenCalledTimes(3)

    // 长跑 ~13 分钟：仅再 3 次（215/455/935s 处），无退避时将 spawn ~150 次
    for (let i = 0; i < 155; i++) await step(POLL_INTERVAL_MS)
    expect(vi.mocked(runTmux).mock.calls.length).toBeLessThanOrEqual(6)
    // 「探测失败≠会话结束」：全程保守判存活，无完成通知、监听未中断
    expect(notify).not.toHaveBeenCalled()
  })

  it('退避期间 tmux 恢复可用 → 正常重建 opts 缓存并三态探测，gone 照常触发完成通知', async () => {
    vi.mocked(runTmux).mockResolvedValue({ code: 127, stdout: '', stderr: 'not found' })
    const w = registerTmuxTools(makeApi(notify), CFG)
    w.watch('pi-recover', '/logs/pi-recover.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 失败 #1

    // tmux 恢复：-V 成功；probeSession 由本 mock 控制（alive → gone）
    vi.mocked(runTmux).mockResolvedValue({ code: 0, stdout: 'tmux 3.4\n', stderr: '' })
    vi.mocked(probeSession).mockResolvedValue('alive')
    await vi.advanceTimersByTimeAsync(PROBE_BACKOFF_BASE_MS + POLL_INTERVAL_MS) // t=40s：负缓存到期重新解析成功
    expect(runTmux).toHaveBeenCalledTimes(2)
    expect(probeSession).toHaveBeenCalled() // cachedOpts 已建立，进入正常探测

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS)
    expect(notify).not.toHaveBeenCalled() // alive 不误报

    vi.mocked(probeSession).mockResolvedValueOnce('gone')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(String((notify.mock.calls[0][0] as { content?: string }).content)).toContain('pi-recover')
  })

  it('probeBackoffMs 纯函数：30s 基准 ×2^n 封顶 10min', () => {
    expect(probeBackoffMs(1)).toBe(30_000)
    expect(probeBackoffMs(2)).toBe(60_000)
    expect(probeBackoffMs(3)).toBe(120_000)
    expect(probeBackoffMs(20)).toBe(600_000)
  })
})
