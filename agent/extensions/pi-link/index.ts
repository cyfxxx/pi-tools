/**
 * pi-link — 多设备 pi 互联扩展
 *
 * 让本机 pi 直接与其他设备（局域网 / Tailscale 组网）上运行的 pi 通信：
 * - `link_send <device> <message>`：向目标设备的 pi 发消息，等待其处理完成并返回最终回复
 * - `link_status`：设备清单与连通性
 * 链路：本机 → ssh → 远程 `pi --mode rpc`（JSONL 协议，官方通道）
 * 安全：SSH 密钥认证；远程默认 --no-extensions（不暴露远程记忆/不触发 plan-mode/autopilot）
 */

import { execSync } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig, configPath, type DeviceConfig, type LinkConfig } from './config.ts'
import { selfName } from './active.ts'
import { writeLocalState } from './state-writer.ts'
import { appendOutbox, extractFinalReply } from './outbox.ts'
import { registerLinkTools } from './tools.ts'
import { registerLinkCommand } from './commands.ts'

export default function (pi: ExtensionAPI): void {
  let cfg = loadConfig()
  const me = selfName(cfg.selfName)
  const refreshCfg = (): void => { cfg = loadConfig() }

  let tmuxFailCache = 0
  const TMUX_FAIL_TTL_MS = 60_000
  function detectTmuxSession(): string | undefined {
    if (Date.now() - tmuxFailCache < TMUX_FAIL_TTL_MS) return undefined
    try {
      if (process.env.TMUX) {
        const out = execSync('tmux display-message -p "#S" 2>/dev/null', { timeout: 3000 }).toString().trim()
        if (out) return out
      }
    } catch {
      if (process.env.TMUX) tmuxFailCache = Date.now()
    }
    return undefined
  }
  const tmuxSessionOf = (): string | undefined => detectTmuxSession()

  pi.on('input', async (event: { text?: string }) => {
    const text = typeof event?.text === 'string' ? event.text : ''
    const { touchActive } = await import('./active.ts')
    touchActive(me, text)
  })

  pi.on('agent_end', async (e: { messages: unknown[] }) => {
    const text = extractFinalReply(e?.messages)
    if (text) appendOutbox(me, text)
  })

  writeLocalState({ device: me, status: 'idle', tmuxSession: tmuxSessionOf() })
  pi.on('turn_start', async () => {
    writeLocalState({ device: me, status: 'busy', tmuxSession: tmuxSessionOf() })
  })
  pi.on('agent_settled', async () => {
    writeLocalState({ device: me, status: 'idle', tmuxSession: tmuxSessionOf() })
  })

  registerLinkTools(pi, () => cfg, refreshCfg, me)
  registerLinkCommand(pi, () => cfg, refreshCfg, me)
}

export type { DeviceConfig, LinkConfig }
