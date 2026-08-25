import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCompletionWatcher, POLL_INTERVAL_MS, MERGE_WINDOW_MS } from '../watcher.ts'

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
    // 第三次轮询：会话消失 → 入合并窗口 → 窗口到点后通知
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS)
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
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3 + MERGE_WINDOW_MS)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  // 审计 MEDIUM：探测失败（抛错/unknown）≠ 会话结束——不得触发 onDone
  //（否则 tools.ts 会误删 watcherHandles/registry 条目并空唤醒通知）
  it('hasSession 持续探测失败（抛错/unknown）→ 不触发 onDone 不通知', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    const w = createCompletionWatcher({
      // 模拟 tmux 二进制消失/spawn 瞬时故障：闭包对探错保守返回 true（存活）
      hasSession: vi.fn(async () => true),
      notify,
      onDone,
    })
    w.watch('pi-probe-fail', '/logs/pi-probe-fail.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4 + MERGE_WINDOW_MS)
    expect(onDone).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('stop() 后不再监听', async () => {
    const { w, notify } = makeWatcher([false, false])
    const h = w.watch('pi-stop', '/logs/pi-stop.log', true)
    h.stop()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(notify).not.toHaveBeenCalled()
  })

  // ── 审计 LOW：会话自然完成时清理外部句柄引用 ────────────────
  it('会话自然完成（watch 探测到 !alive）→ onDone 回调触发一次（tools.ts 借以删 watcherHandles/registry 条目）', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    let i = 0
    const w = createCompletionWatcher({
      hasSession: vi.fn(async () => (i++ < 1 ? true : false)), // 存活一次后消失
      notify,
      onDone,
    })
    w.watch('pi-done', '/logs/pi-done.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2 + MERGE_WINDOW_MS)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('pi-done')
    // 定时器已停：后续轮询不再重复回调
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('stop()（tmux_stop 主动停止）不触发 onDone——主动停止路径由调用方自清理', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const onDone = vi.fn()
    const w = createCompletionWatcher({
      hasSession: vi.fn(async () => true), // 一直在存活
      notify,
      onDone,
    })
    const h = w.watch('pi-stop2', '/logs/pi-stop2.log', true)
    h.stop()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(onDone).not.toHaveBeenCalled()
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
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS) // 会话消失 → 通知 1
    expect(notify).toHaveBeenCalledTimes(1)
    // 同名重新注册（新会话）：notified 必须被清除
    w.watch('pi-reuse', '/logs/pi-reuse.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2) // 新会话还在
    expect(notify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS) // 新会话消失 → 再通知
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

  // ── 防积压：同批合并 ────────────────────────────────────────
  it('同 window 内多个会话完成 → 合成一条汇总通知（防 N 条触发消息积压）', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const states = new Map<string, boolean>([
      ['pi-a', true],
      ['pi-b', true],
      ['pi-c', true],
    ])
    const w = createCompletionWatcher({
      hasSession: vi.fn(async (n: string) => states.get(n) ?? true),
      notify,
    })
    w.watch('pi-a', '/logs/pi-a.log', true)
    w.watch('pi-b', '/logs/pi-b.log', true)
    w.watch('pi-c', '/logs/pi-c.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第一轮：均存活
    states.set('pi-a', false)
    states.set('pi-b', false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第二轮：a、b 同时消失
    expect(notify).not.toHaveBeenCalled() // 合并窗口未到，不发送
    states.set('pi-c', false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第三轮：c 也消失（同窗口内）
    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS) // 窗口到点 → 一条汇总
    expect(notify).toHaveBeenCalledTimes(1)
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain('已完成 3 个')
    expect(text).toContain('pi-a')
    expect(text).toContain('pi-b')
    expect(text).toContain('pi-c')
    expect(text).toContain('tmux_read')
    // 后续不再有通知（队列已清）
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  // ── 防积压：消费标记 ack ────────────────────────────────────
  it('ack（tmux_read 已读取）未完成会话 → 完成时不再通知', async () => {
    const { w, notify } = makeWatcher([true, false, false, false])
    w.watch('pi-acked', '/logs/pi-acked.log', true)
    w.ack('pi-acked') // 模拟 tmux_read 已查看日志
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3 + MERGE_WINDOW_MS)
    expect(notify).not.toHaveBeenCalled()
  })

  it('ack 已完成未 flush 的会话（pending 中）→ 从合并队列移除不通知', async () => {
    const { w, notify } = makeWatcher([true, false, true, true]) // 存活→消失→（后续轮询不干扰）
    w.watch('pi-pend', '/logs/pi-pend.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第一轮：存活
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第二轮：消失 → 入 pending
    w.ack('pi-pend') // 完成待通知期间被消费（如 tmux_read 兜底读取）
    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS) // 窗口到点
    expect(notify).not.toHaveBeenCalled()
  })

  it('ack 后同名重新 watch：新会话结束仍通知（acked 残留不静默丢通知）', async () => {
    // [true, false, true, false]：第一段会话被 ack 后仍完成的一轮 → 第二段重注册
    const { w, notify } = makeWatcher([true, false, true, false])
    w.watch('pi-reack', '/logs/pi-reack.log', true)
    w.ack('pi-reack')
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2 + MERGE_WINDOW_MS)
    expect(notify).not.toHaveBeenCalled() // 第一段：acked → 不通知
    // 同名重注册（新会话）：acked 必须被清除，新会话结束仍通知
    w.watch('pi-reack', '/logs/pi-reack.log', true)
    // 推进量需覆盖“轮询发现消失 + 合并窗口到点”（轮询在段尾，flush 在 +MERGE_WINDOW）
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + MERGE_WINDOW_MS * 2)
    expect(notify).toHaveBeenCalledTimes(1)
    const text = notify.mock.calls[0][0] as string
    expect(text).toContain('pi-reack')
  })

  // ── 防积压：主动停止丢弃 pending ────────────────────────────
  it('stop()（tmux_stop 主动停止）丢弃已完成待通知条目，不触发空通知', async () => {
    const notify = vi.fn().mockResolvedValue(undefined)
    const states = new Map<string, boolean>([['pi-x', true]])
    const w = createCompletionWatcher({
      hasSession: vi.fn(async (n: string) => states.get(n) ?? true),
      notify,
    })
    const h = w.watch('pi-x', '/logs/pi-x.log', true)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第一轮：存活
    states.set('pi-x', false)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) // 第二轮：消失 → 入 pending
    h.stop() // 竞态：轮询已探测到消失但未 flush，用户 tmux_stop 主动停止
    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS)
    expect(notify).not.toHaveBeenCalled()
  })
})