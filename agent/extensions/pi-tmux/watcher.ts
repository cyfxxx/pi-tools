/**
 * 完成自动唤醒 — tmux 会话结束后触发新回合让主会话处理结果。
 *
 * 背景：tmux_run 后台跑长任务后，回合结束等用户输入；任务完成无人通知，
 * 结果要等用户下轮发消息才被查看。本模块在 tmux_run 启动会话后轮询
 * tmux has-session，会话消失即完成，经 pi.sendMessage({triggerTurn:true})
 * 注入通知消息并触发新回合——主会话被唤醒后 tmux_read 查看并继续收尾。
 *
 * 风险防范（全部经测试覆盖）：
 * - 去重：同会话只通知一次（notified Set）
 * - 防泄漏：定时器 unref + stopAll（session_shutdown 清理）+ 同名覆盖
 * - 静默容错：hasSession/sendMessage 异常不抛、不中断轮询
 * - 可控：notify=false 不注册；沿用已有会话（started=false）不注册
 * - 缓存友好：通知文本无时间戳等动态内容
 *
 * 防积压（2026-08-19 待办：完成通知批量延迟/冗余报警）：
 * - 同批合并：完成事件先进 pending 队列，MERGE_WINDOW_MS（=轮询间隔）固定
 *   窗口从首个完成起算，窗口内到期的会话合成一条汇总通知（单条仍走原格式）——
 *   批量任务同轮完成时不再 N 条各自 sendMessage 积压在 harness 队列
 * - 消费标记：tmux_read 成功读取后调用 ack(name)——用户已人工查看过，
 *   该会话完成时不再通知（含已入 pending 未 flush 的，直接移除）
 * - stop() 丢弃该会话 pending 条目：tmux_stop 主动停止后不触发空通知
 *   约束说明：harness 侧"回合进行中 triggerTurn 排队、下条用户消息才 flush"
 *   的行为无法从扩展侧改变（sendMessage 后不可撤回），积压消息过期同样
 *   需要 harness 支持——扩展侧只做合并降冗 + 已消费免打扰
 */

export interface WatcherDeps {
  /** 探测会话是否存活（闭包注入 tmux opts） */
  hasSession: (name: string) => Promise<boolean>
  /** 触发新回合的通知（闭包注入 pi.sendMessage） */
  notify: (text: string) => Promise<void>
}

export interface WatcherHandle {
  stop(): void
}

export interface CompletionWatcher {
  watch(name: string, logPath: string, notifyEnabled: boolean): WatcherHandle
  /** 标记会话已被消费（tmux_read 成功读取）：完成时不再通知；已 flush 的无法撤回 */
  ack(name: string): void
  stopAll(): void
}

export const POLL_INTERVAL_MS = 5000
/** 完成通知合并窗口：= 轮询间隔，同轮批量完成的会话合成一条汇总 */
export const MERGE_WINDOW_MS = 5000
export const NOTIFY_CUSTOM_TYPE = 'pi-tmux-notify'

interface PendingItem {
  name: string
  logPath: string
}

export function createCompletionWatcher(deps: WatcherDeps): CompletionWatcher {
  const timers = new Map<string, NodeJS.Timeout>()
  const notified = new Set<string>()
  /** 已被消费（tmux_read）的会话：完成时不通知（ack 标记） */
  const acked = new Set<string>()
  /** 已完成待合并通知的会话（合并窗口内聚合，flush 后清空） */
  const pending = new Map<string, PendingItem>()
  let mergeTimer: NodeJS.Timeout | null = null

  function flush(): void {
    mergeTimer = null
    if (pending.size === 0) return
    const items = [...pending.values()]
    pending.clear()
    let text: string
    if (items.length === 1) {
      const it = items[0]
      // 单条保持原格式（含 tmux_read 提示，缓存友好无时间戳）
      text =
        `tmux 会话 ${it.name} 已结束。请用 tmux_read(name=${it.name}) 查看日志并处理收尾。` +
        `日志: ${it.logPath}（tmux_run 自动完成唤醒通知）`
    } else {
      text =
        `tmux 会话已完成 ${items.length} 个（批量完成通知）：\n` +
        items.map((it) => `- ${it.name}（日志: ${it.logPath}）`).join('\n') +
        `\n请用 tmux_read(name=...) 查看日志并处理收尾（tmux_run 自动完成唤醒通知）`
    }
    deps.notify(text).catch(() => {
      // 通知失败（进程退出中/内核忙）：静默，不影响任何后续
    })
  }

  /** 合并窗口从首个完成事件起算（固定窗口不重置，防持续完成导致通知无限推迟） */
  function scheduleFlush(): void {
    if (mergeTimer) return
    mergeTimer = setTimeout(flush, MERGE_WINDOW_MS)
    mergeTimer.unref?.()
  }

  function clear(name: string): void {
    const t = timers.get(name)
    if (t) {
      clearInterval(t)
      timers.delete(name)
    }
  }

  function watch(name: string, logPath: string, notifyEnabled: boolean): WatcherHandle {
    clear(name) // 同名重复注册：旧监听器先停，防多定时器
    // 审计 MEDIUM：同名重新注册 = 新会话启动（tmux_stop 后同名 tmux_run），
    // 旧会话的 notified/acked 标记与 pending 条目必须清除——
    // 否则新会话结束时不发完成通知（静默丢通知）或误合并旧完成事件
    notified.delete(name)
    acked.delete(name)
    pending.delete(name)
    if (!notifyEnabled) return { stop: () => {} }

    const timer = setInterval(async () => {
      let alive: boolean
      try {
        alive = await deps.hasSession(name)
      } catch {
        // tmux 瞬时故障（如服务重启）：静默跳过，下一轮再探，不中断监听
        return
      }
      if (alive) return

      clear(name)
      if (notified.has(name)) return // 已通知过（防并发轮询重复触发）
      notified.add(name)
      if (acked.has(name)) return // 已被 tmux_read 消费：不再通知（不打扰）
      pending.set(name, { name, logPath })
      scheduleFlush()
    }, POLL_INTERVAL_MS)

    // 不阻止进程退出：pi 关闭时定时器随进程消失，无需显式清理
    timer.unref?.()
    timers.set(name, timer)
    return {
      stop() {
        clear(name)
        // tmux_stop 主动停止：会话已人工结束（工具返回结果），
        // 丢弃其 pending 条目，防轮询竞态（已探测到消失未 flush）触发空通知
        pending.delete(name)
      },
    }
  }

  return {
    watch,
    ack(name: string): void {
      // 已完成未 flush（pending 中）：直接移除，不再通知
      pending.delete(name)
      // 仍在轮询（未完成）：标记消费，完成时跳过通知
      // （已 flush 的通知在 harness 队列中无法撤回，无操作）
      acked.add(name)
    },
    stopAll() {
      for (const name of [...timers.keys()]) clear(name)
      if (mergeTimer) {
        clearTimeout(mergeTimer)
        mergeTimer = null
      }
      notified.clear()
      acked.clear()
      pending.clear()
    },
  }
}
