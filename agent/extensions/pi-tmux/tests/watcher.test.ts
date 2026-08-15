import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCompletionWatcher, POLL_INTERVAL_MS } from '../watcher.ts'

describe('pi-tmux completion watcher（完成自动唤醒）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeWatcher(sequence: boolean[]) {
    let i = 0
    const notify = vi.fn().mockResolvedValue(undefined)
    const w = createCompletionWatcher({
      hasSession: vi.fn(async () => (i < sequence.length ? sequence[i++] : true)),
      notify,
    })
    return { w, notify }
  }

  it('会话从存在变消失 → 通知一次并触发新回合', async () => {
    const { w, notify } = makeWatcher([true, true, false])
    w.watch('pi-build', '/logs/pi-build.log', true)
    // 前两次轮询：仍存活
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(notify).not.toHaveBeenCalled()
    // 第三次轮询：会话消失 → 通知
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(notify).toHaveBeenCalledTimes(1)
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain('pi-build')
    expect(text).toContain('tmux_read(name=pi-build)')
    expect(text).toContain('已结束')
    // 后续轮询不再通知（去重）
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('notify=false 不注册监听（无定时器无通知）', async () => {
    const { w, notify } = makeWatcher([false])
    w.watch('pi-silent', '/logs/pi-silent.log', false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(notify).not.toHaveBeenCalled()
  })

  it('hasSession 异常静默跳过，后续仍可通知', async () => {
    let calls = 0
    const notify = vi.fn().mockResolvedValue(undefined)
    const w = createCompletionWatcher({
      hasSession: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('tmux 挂了')
        return calls < 3 // 第 1 次抛错，第 2 次存活，第 3 次消失
      }),
      notify,
    })
    w.watch('pi-flaky', '/logs/pi-flaky.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('stop() 后不再监听', async () => {
    const { w, notify } = makeWatcher([false, false])
    const h = w.watch('pi-stop', '/logs/pi-stop.log', true)
    h.stop()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).not.toHaveBeenCalled()
  })

  it('同名重复注册：旧监听器停止，只留一个', async () => {
    const { w, notify } = makeWatcher([false, false])
    w.watch('pi-dup', '/logs/pi-dup.log', true)
    w.watch('pi-dup', '/logs/pi-dup.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('通知后同名重新 watch：新会话结束仍通知（审计 MEDIUM：notified 残留静默丢通知）', async () => {
    // 序列：[true, true, false, true, true, false]——第一段会话存在×2→消失→通知；
    // 重注册后第二段新会话存在×2→消失→再通知
    const { w, notify } = makeWatcher([true, true, false, true, true, false])
    w.watch('pi-reuse', '/logs/pi-reuse.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2) // 会话还在
    expect(notify).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 会话消失 → 通知 1
    expect(notify).toHaveBeenCalledTimes(1)
    // 同名重新注册（新会话）：notified 必须被清除
    w.watch('pi-reuse', '/logs/pi-reuse.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2) // 新会话还在
    expect(notify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 新会话消失 → 再通知
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('stopAll 清空全部监听（session_shutdown 路径）', async () => {
    const { w, notify } = makeWatcher([false, false])
    w.watch('pi-a', '/logs/pi-a.log', true)
    w.watch('pi-b', '/logs/pi-b.log', true)
    w.stopAll()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).not.toHaveBeenCalled()
  })
})
