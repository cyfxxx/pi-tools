import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig, toTmuxOpts } from './config'
import { registerTmuxTools } from './tools'
import { listSessions, killSession, isPiSession, loadRegistry } from './core'

/**
 * pi-tmux — tmux 集成扩展
 *
 * 让 Pi 智能使用 tmux：后台持久会话、pipe-pane 日志落盘、send-keys 交互、wait 轮询。
 * 会话统一 pi- 前缀命名；pi 退出时清理本扩展创建的 pi- 会话（不碰用户会话）。
 */
export default function (pi: ExtensionAPI): void {
  const cfg = loadConfig()

  registerTmuxTools(pi, cfg)

  // 退出时清理：仅清理 pi- 前缀且在本扩展注册表中的会话，绝不触碰用户会话
  pi.on('session_shutdown', async () => {
    try {
      const opts = toTmuxOpts(cfg)
      const reg = loadRegistry()
      const sessions = await listSessions(opts)
      for (const s of sessions) {
        if (isPiSession(s.name, cfg.prefix) && reg.sessions[s.name]) {
          await killSession(opts, s.name).catch(() => {})
        }
      }
    } catch { /* 清理失败不影响退出 */ }
  })
}
