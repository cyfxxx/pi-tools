import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'

/**
 * 局域网 IPv4 探测（移植自 dsh-pocket service.mjs，GPL-2.0）：
 * - selectLanIPv4：打分选卡（Windows 枚举顺序不可靠，Radmin/Tailscale/vEthernet 常排在物理网卡前）
 * - WSL2 是 NAT，本机只能看到 172.x 虚拟网卡 → 检测 WSL 后走 interop 执行 ipconfig.exe
 *   取 Windows 物理网卡 IP（明确不用 WSLENV 判断——Windows Terminal 在原生 Windows 也设它，会误判）
 */

/** 严格 IPv4 校验（4 段各 0-255；拒绝前导多余字符） */
export function isValidIpv4(v: string): boolean {
  const parts = v.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

const PRIVATE_RE = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./
const PHYSICAL_RE = /wlan|wi-fi|wifi|ethernet|eth\d|en\d|以太网|无线/i
const VIRTUAL_RE =
  /radmin|tailscale|zerotier|tun\d|tap\d|vpn|vethernet|wsl|docker|vmware|virtualbox|hyper-v|loopback|virbr|veth|br-/i

export interface IfaceInfo {
  /** 网卡名（Windows 为中英文适配器标题，POSIX 为接口名） */
  name: string
  address: string
}

/**
 * 打分选择最可能"对外可达"的 LAN IPv4：
 * RFC1918 私网 +100；名称像物理网卡 +20；名称像 VPN/虚拟网卡 −50；
 * 同分保持枚举序（严格大于才替换）；回环 127.x 与 link-local 169.254.x 排除；
 * 非私网地址保留兜底（纯 VPN 环境仍可用）。
 */
export function selectLanIPv4(interfaces: IfaceInfo[]): string | undefined {
  let best: { iface: IfaceInfo; score: number } | undefined
  for (const it of interfaces) {
    if (it.address.startsWith('127.') || it.address.startsWith('169.254.')) continue
    if (!isValidIpv4(it.address)) continue
    let score = 0
    if (PRIVATE_RE.test(it.address)) score += 100
    if (PHYSICAL_RE.test(it.name)) score += 20
    if (VIRTUAL_RE.test(it.name)) score -= 50
    if (!best || score > best.score) best = { iface: it, score }
  }
  return best?.iface.address
}

/** WSL 判定（纯函数便于测试）：/proc/version 含 microsoft/wsl，或 WSL_DISTRO_NAME/WSL_INTEROP 已设 */
export function looksLikeWsl(procVersionText: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const v = procVersionText?.toLowerCase()
  if (v && (v.includes('microsoft') || v.includes('wsl'))) return true
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP)
}

function readProcVersion(): string | undefined {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return undefined
  }
}

export function detectWsl(): boolean {
  return looksLikeWsl(readProcVersion(), process.env)
}

/**
 * 解析 ipconfig.exe 输出 → 网卡块列表。
 * 结构约定：块标题行顶格、内容行缩进（空行分块），按 `\n(?=\S)` 切块即可；
 * 跳过标题命中虚拟网卡关键词的块；兼容中文「IPv4 地址」与英文 "IPv4 Address"，
 * 宽容匹配尾部标注（如 "(首选)"）。
 */
export function parseIpconfig(text: string): IfaceInfo[] {
  const out: IfaceInfo[] = []
  for (const block of text.split(/\r?\n(?=\S)/)) {
    const lines = block.split(/\r?\n/)
    const title = (lines[0] ?? '').trim()
    if (!title || VIRTUAL_RE.test(title)) continue
    for (const line of lines.slice(1)) {
      const m = line.match(/IPv4[^:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})/i)
      if (m && isValidIpv4(m[1])) out.push({ name: title, address: m[1] })
    }
  }
  return out
}

/** 经 interop 取 Windows 物理网卡 LAN IPv4（PATH 找不到时回退绝对路径） */
export function windowsLanIPv4(): string | undefined {
  const candidates = ['ipconfig.exe', '/mnt/c/Windows/System32/ipconfig.exe']
  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, { timeout: 5000, windowsHide: true }).toString()
      const picked = selectLanIPv4(parseIpconfig(out))
      if (picked) return picked
    } catch {
      /* 试下一个候选 */
    }
  }
  return undefined
}

/** 本机对外可达的 LAN IPv4：Tailscale 由调用方优先处理；此处 WSL 下取 Windows 物理网卡，否则打分选卡 */
export function detectLanIPv4(): string | undefined {
  try {
    if (detectWsl()) {
      const wsl = windowsLanIPv4()
      if (wsl) return wsl
    }
  } catch {
    /* 回退本机枚举 */
  }
  const interfaces: IfaceInfo[] = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a && a.family === 'IPv4' && a.address) interfaces.push({ name, address: a.address })
    }
  }
  return selectLanIPv4(interfaces)
}
