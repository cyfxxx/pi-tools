import { homedir } from 'node:os'
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * pi-link 配置：设备清单（每环境独立，gitignored）
 *
 * ~/.pi/pi-link.json:
 * {
 *   "devices": {
 *     "phone":  { "host": "100.101.102.103", "user": "u0_a123", "port": 8022, "timeoutSec": 600 },
 *     "laptop": { "host": "100.200.300.400", "user": "myuser", "cwd": "~/work" },
 *     "dual":   { "host": "192.168.1.5", "port": 8022, "user": "u0_a1",
 *                 "altHosts": [ { "host": "100.101.102.103", "port": 8022 } ] }
 *   },
 *   "defaultTimeoutSec": 600
 * }
 * 说明：altHosts 为备用地址（虚拟局域网/其他网段），按序尝试 failover——
 * 主地址（host/port）优先，全部不可达时用下一备用，直到成功或全部失败。
 */
export interface DeviceAddr {
  host: string
  port?: number
}

export interface DeviceConfig {
  /** 主地址（Tailscale IP 或局域网 IP） */
  host: string
  /** SSH 用户名 */
  user: string
  /** 主地址 SSH 端口，默认 22 */
  port?: number
  /** 备用地址列表（failover 按序尝试；可选） */
  altHosts?: DeviceAddr[]
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
        const dev = { ...d }
        // altHosts 结构校验：仅保留 host 为字符串的条目（无效条目丢弃）
        if (Array.isArray(dev.altHosts)) {
          dev.altHosts = dev.altHosts.filter(a => a && typeof a.host === 'string' && a.host)
        }
        // 审计 MEDIUM：仅校验 host 时手工编辑 pi-link.json 可绕过 import-card 加固——
        // user 以 `-` 开头/含空白会被 ssh 解析为选项（如 -o ProxyCommand → 本机执行面）。
        // 加载时同规则校验，非法字段丢弃回退默认（与 saveDevice 名称规则对齐）。
        if (dev.user !== undefined && (typeof dev.user !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(dev.user) || dev.user.startsWith('-'))) {
          delete dev.user
        }
        if (dev.port !== undefined && (typeof dev.port !== 'number' || !Number.isInteger(dev.port) || dev.port < 1 || dev.port > 65535)) {
          delete dev.port
        }
        // sshArgs 仅做形态校验（应为字符串数组）；内容为本地显式配置、非远端进入面，不做白名单限制
        if (dev.sshArgs !== undefined && !Array.isArray(dev.sshArgs)) {
          delete dev.sshArgs
        }
        cfg.devices[name] = dev
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

/** 写入/更新设备（保存回 pi-link.json；T2-5 卡片导入用） */
export function saveDevice(path: string, name: string, d: DeviceConfig): { ok: boolean; detail: string } {
  const nameOk = /^[a-zA-Z0-9_-]+$/.test(name)
  if (!nameOk) return { ok: false, detail: `设备名 "${name}" 非法（仅字母数字-下划线）` }
  const cfg = loadConfig(path)
  const existed = name in cfg.devices
  cfg.devices[name] = { ...d }
  try {
    mkdirSync(dirname(path), { recursive: true })
    // 审计 MEDIUM（2026-08-25）：tmp+rename 原子写（同 autoconfig 先例）——直接
    // writeFileSync 中断留截断 JSON 时 loadConfig 静默回退默认，全部设备配置丢失
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
  } catch (e) {
    return { ok: false, detail: `写入失败: ${(e as Error).message}` }
  }
  return { ok: true, detail: existed ? `已更新设备 "${name}"` : `已添加设备 "${name}"` }
}

export function describeDevice(name: string, d: DeviceConfig): string {
  const alts = Array.isArray(d.altHosts) && d.altHosts.length > 0
    ? ` +${d.altHosts.length}备用`
    : ''
  return `${name} → ${d.user}@${d.host}:${d.port ?? 22}${alts}`
}

/** 设备全部地址（主地址优先 + 备用按序） */
export function deviceAddresses(d: DeviceConfig): DeviceAddr[] {
  const addrs: DeviceAddr[] = [{ host: d.host, port: d.port }]
  if (Array.isArray(d.altHosts)) {
    for (const a of d.altHosts) {
      if (a && typeof a.host === 'string' && a.host) addrs.push(a)
    }
  }
  return addrs
}

