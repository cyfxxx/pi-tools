import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig, toTmuxOpts } from './config'
import { registerTmuxTools } from './tools'
import { listSessions, loadRegistry, shutdownCleanup } from './core'

/**
 * pi-tmux — tmux 集成扩展
 *
 * 让 Pi 智能使用 tmux：后台持久会话、pipe-pane 日志落盘、send-keys 交互、wait 轮询。
 * 会话统一 pi- 前缀命名；pi 退出时清理本扩展创建的 pi- 会话（不碰用户会话）。
 */
export default function (pi: ExtensionAPI): void {
  const cfg = loadConfig()

  const watcher = registerTmuxTools(pi, cfg)

  // 退出时清理：仅清理 pi- 前缀且在本扩展注册表中的会话，绝不触碰用户会话
  // 审计 MEDIUM：多实例并行时仅杀 owner===本会话 的后台任务；owner 空/缺失的
  // 旧条目视为公共遗留仍可杀（向后兼容）；他人任务保留并在日志注明跳过数
  pi.on('session_shutdown', async () => {
    watcher.stopAll() // 完成唤醒监听器先停（定时器 unref，不阻塞退出）
    try {
      const opts = toTmuxOpts(cfg)
      const reg = loadRegistry()
      const sessions = await listSessions(opts)
      const { killed, skippedOthers } = await shutdownCleanup(
        opts, reg, sessions, cfg.prefix, process.env.PI_SESSION_ID || '',
      )
      if (killed.length > 0 || skippedOthers.length > 0) {
        console.error(
          `[pi-tmux] shutdown: 杀掉 ${killed.length} 个本会话后台任务` +
          (skippedOthers.length > 0
            ? `，跳过 ${skippedOthers.length} 个其他 pi 会话的任务（${skippedOthers.join(', ')}）`
            : ''),
        )
      }
    } catch { /* 清理失败不影响退出 */ }
  })
}
