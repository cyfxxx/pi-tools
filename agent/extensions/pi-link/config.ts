import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * pi-link 配置：设备清单（每环境独立，gitignored）
 *
 * ~/.pi/pi-link.json:
 * {
 *   "devices": {
 *     "phone":  { "host": "100.101.102.103", "user": "u0_a123", "port": 8022, "timeoutSec": 600 },
 *     "laptop": { "host": "100.200.300.400", "user": "myuser", "cwd": "~/work" }
 *   },
 *   "defaultTimeoutSec": 600
 * }
 */
export interface DeviceConfig {
  /** Tailscale IP 或局域网 IP */
  host: string
  /** SSH 用户名 */
  user: string
  /** SSH 端口，默认 22 */
  port?: number
  /** 远程 RPC 会话工作目录（远程 shell 展开，默认远程用户 home） */
  cwd?: string
  /** 单次调用超时（秒），默认 defaultTimeoutSec */
  timeoutSec?: number
  /** 远程会话存储目录（远程侧路径），默认 ~/.pi/agent/sessions/pi-link */
  sessionDir?: string
  /** 是否加载扩展（默认 false：--no-extensions，干净且不暴露远程记忆/不触发 plan-mode） */
  extensions?: boolean
  /** 附加 ssh 参数 */
  sshArgs?: string[]
  /** 会话策略：continue=复用上次会话（默认），fresh=每次新会话 */
  sessionPolicy?: 'continue' | 'fresh'
}

export interface LinkConfig {
  devices: Record<string, DeviceConfig>
  defaultTimeoutSec: number
  /** 本机身份名（指令头/活跃状态用；默认 hostname） */
  selfName?: string
  /** 无人值守（本机无用户交互）时是否允许发送跨设备指令，默认 false */
  allowUnattended?: boolean
}

const DEFAULT_SESSION_DIR = '~/.pi/agent/sessions/pi-link'

export function defaultConfig(): LinkConfig {
  return { devices: {}, defaultTimeoutSec: 600 }
}

export function configPath(): string {
  const env = process.env.PI_LINK_CONFIG
  if (env) return env
  return join(homedir(), '.pi', 'pi-link.json')
}

export function loadConfig(path = configPath()): LinkConfig {
  const cfg = defaultConfig()
  if (!existsSync(path)) return cfg
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LinkConfig>
    if (raw.devices) {
      for (const [name, d] of Object.entries(raw.devices)) {
        if (!d || typeof d.host !== 'string' || !d.host) continue
        cfg.devices[name] = { ...d }
      }
    }
    if (typeof raw.defaultTimeoutSec === 'number' && raw.defaultTimeoutSec > 0) {
      cfg.defaultTimeoutSec = raw.defaultTimeoutSec
    }
    if (typeof raw.selfName === 'string' && raw.selfName) cfg.selfName = raw.selfName
    if (typeof raw.allowUnattended === 'boolean') cfg.allowUnattended = raw.allowUnattended
  } catch {
    // 配置损坏按默认处理
  }
  return cfg
}

export function getDevice(cfg: LinkConfig, name: string): DeviceConfig | undefined {
  return cfg.devices[name]
}

export function describeDevice(name: string, d: DeviceConfig): string {
  return `${name} → ${d.user}@${d.host}:${d.port ?? 22}`
}

export function sessionDirOf(d: DeviceConfig): string {
  return d.sessionDir ?? DEFAULT_SESSION_DIR
}
