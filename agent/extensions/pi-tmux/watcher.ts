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
  stopAll(): void
}

export const POLL_INTERVAL_MS = 5000
export const NOTIFY_CUSTOM_TYPE = 'pi-tmux-notify'

export function createCompletionWatcher(deps: WatcherDeps): CompletionWatcher {
  const timers = new Map<string, NodeJS.Timeout>()
  const notified = new Set<string>()

  function clear(name: string): void {
    const t = timers.get(name)
    if (t) {
      clearInterval(t)
      timers.delete(name)
    }
  }

  function watch(name: string, logPath: string, notifyEnabled: boolean): WatcherHandle {
    clear(name) // 同名重复注册：旧监听器先停，防多定时器
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
      try {
        await deps.notify(
          `tmux 会话 ${name} 已结束。请用 tmux_read(name=${name}) 查看日志并处理收尾。` +
            `日志: ${logPath}（tmux_run 自动完成唤醒通知）`,
        )
      } catch {
        // 通知失败（进程退出中/内核忙）：静默，不影响任何后续
      }
    }, POLL_INTERVAL_MS)

    // 不阻止进程退出：pi 关闭时定时器随进程消失，无需显式清理
    timer.unref?.()
    timers.set(name, timer)
    return { stop: () => clear(name) }
  }

  return {
    watch,
    stopAll() {
      for (const name of [...timers.keys()]) clear(name)
      notified.clear()
    },
  }
}
