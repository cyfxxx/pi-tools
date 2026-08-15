import { execSync } from 'node:child_process'
import type { DeviceConfig, LinkConfig } from './config.ts'

/**
 * 设备卡片（T2-5，A2A Agent Card 简版）：
 * 描述一台设备如何被连接，通过 /link export-card / import-card 交换。
 * 交换式发现——不引入 mDNS/HTTP daemon（ssh 通道零守护是 pi-link 架构优势）。
 */
export interface AgentCard {
  /** 设备显示名（对应 pi-link.json 的 devices 键） */
  name: string
  /** 本设备可提供的能力描述（自由文本） */
  skills: string[]
  host: string
  user: string
  port: number
  /** 该设备是否可执行跨设备指令（是否运行 pi） */
  pi?: boolean
}

/** 探测本机 Tailscale IP（供 export-card 默认值；无 Tailscale 返回 undefined） */
/** 仅取 IPv4 地址（部分 tailscale 版本 -4 仍输出 IPv6 ULA，sshd 多不监听 v6） */
const ipv4Of = (raw: string): string | undefined =>
  raw.split(/\s+/).find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x))

export function detectTailscaleIP(): string | undefined {
  try {
    const out = execSync('tailscale ip -4 2>/dev/null', { timeout: 3000 }).toString().trim()
    return ipv4Of(out)
  } catch {
    return undefined
  }
}

/** 构建本机卡片：host 优先 Tailscale IP，其次 hostname -I 的第一个内网 IP */
export function buildCard(cfg: LinkConfig): AgentCard {
  const name = cfg.selfName ?? process.env.HOSTNAME ?? 'pi-device'
  let host = detectTailscaleIP()
  if (!host) {
    try {
      const out = execSync("hostname -I 2>/dev/null", { timeout: 3000 }).toString().trim()
      host = ipv4Of(out)
    } catch {
      host = undefined
    }
  }
  return {
    name,
    skills: ['pi agent（可执行跨设备指令、观察/介入远程会话）', 'pi-link: ssh 通道 RPC'],
    host: host ?? '请填写本机 IP',
    user: process.env.USER ?? 'root',
    port: 22,
    pi: true,
  }
}

/**
 * ssh 目标 user@host 合法性：'-' 开头会被 ssh 解析为选项（审计实测：user 取
 * -oProxyCommand=sh -c ... 时 ProxyCommand 在本机执行成功）。拒绝 - 开头/空白/控制字符。
 * host 同规则（IPv6 方括号 [::1] 含 : 与 [] 均合法；不含空白即可）。
 */
export function isValidUserHost(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 253 && /^[^\s][^\s]*$/.test(v) && !v.startsWith('-')
}

/** 校验并规范化卡片（导入前） */
export function validateCard(card: unknown): { ok: boolean; card?: AgentCard; detail?: string } {
  if (!card || typeof card !== 'object') return { ok: false, detail: '卡片不是对象' }
  const c = card as Record<string, unknown>
  if (typeof c.name !== 'string' || !c.name) return { ok: false, detail: '卡片缺少 name' }
  if (!isValidUserHost(c.host)) return { ok: false, detail: 'host 非法（拒绝 - 开头/空白/控制字符）' }
  if (!isValidUserHost(c.user)) return { ok: false, detail: 'user 非法（拒绝 - 开头/空白/控制字符）' }
  const port = typeof c.port === 'number' ? c.port : 22
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, detail: `端口非法: ${port}` }
  const skills = Array.isArray(c.skills) ? c.skills.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  return { ok: true, card: { name: c.name, skills, host: c.host, user: c.user, port, pi: c.pi !== false } }
}

/** 卡片 → 设备配置（保留扩展字段） */
export function cardToDevice(card: AgentCard): DeviceConfig {
  return { host: card.host, user: card.user, port: card.port }
}
