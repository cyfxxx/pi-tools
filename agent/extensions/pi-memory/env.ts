/**
 * pi-memory 环境检测 — 多环境（Termux/WSL2/Linux/macOS）记忆隔离。
 *
 * 记忆条目带 `environments` 标签（缺省 = ['all']）；注入/检索时按当前运行环境
 * 过滤：`all` + 匹配当前环境的条目可见，其余环境专属知识不注入、不混用。
 *
 * 检测优先级：
 * 1. `PI_MEMORY_ENV` 环境变量显式覆盖（最可靠）
 * 2. /storage/emulated/0 存在 → termux（Android）
 * 3. /proc/version 含 microsoft → wsl2
 * 4. uname Darwin → macos
 * 5. 其余 → linux
 */
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

export const ENVIRONMENTS = ['all', 'termux', 'wsl2', 'linux', 'macos'] as const
export type RuntimeEnv = (typeof ENVIRONMENTS)[number]

let cached: RuntimeEnv | null = null

export function detectEnvironment(): RuntimeEnv {
  if (cached) return cached
  const override = process.env.PI_MEMORY_ENV
  if (override && (ENVIRONMENTS as readonly string[]).includes(override)) {
    cached = override as RuntimeEnv
    return cached
  }
  try {
    if (existsSync('/storage/emulated/0')) {
      cached = 'termux'
      return cached
    }
  } catch {
    // 忽略权限错误，继续探测
  }
  try {
    if (existsSync('/proc/version') && readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
      cached = 'wsl2'
      return cached
    }
  } catch {
    // 忽略
  }
  try {
    const uname = execSync('uname', { timeout: 3000 }).toString().trim().toLowerCase()
    if (uname === 'darwin') {
      cached = 'macos'
      return cached
    }
  } catch {
    // uname 不可用，回退 linux
  }
  cached = 'linux'
  return cached
}

/** 测试用：重置缓存。 */
export function resetEnvironmentCache(): void {
  cached = null
}

/**
 * 条目是否对当前环境可见：条目无 environments（旧数据）视为 all；
 * 显式 all 永远可见；否则须包含当前环境。
 */
export function isEnvVisible(environments: string[] | undefined, current: RuntimeEnv): boolean {
  if (!environments || environments.length === 0) return true
  if (environments.includes('all')) return true
  return environments.includes(current)
}

/** 展示用：条目环境描述（缺省 all → '通用'）。 */
export function formatEnvironments(environments: string[] | undefined): string {
  if (!environments || environments.length === 0) return '通用'
  return environments.join(',')
}
