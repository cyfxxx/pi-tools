import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'

/**
 * 活跃设备/身份机制（T2-1）
 *
 * 每台设备的 pi-link 扩展监听用户输入（input 事件）刷新本机活跃时间戳；
 * link_send 发送前校验：本机近期有用户交互（活跃）才允许发送跨设备指令，
 * 防止无人值守设备（如定时任务）乱指挥其他设备。
 * 状态文件 ~/.pi/pi-link-active.json（gitignore 范畴，每机独立）。
 */

export interface ActiveState {
  device: string
  lastActiveAt: number
  /** 最近一次用户输入摘要（前 100 字符） */
  lastInput?: string
  /** 最近一次跨设备发送时间（审计） */
  lastSendAt?: number
}

/** 活跃判定窗口：最近 N 分钟内有过用户交互即视为活跃 */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000

/**
 * 无人值守判定：pi-cron.sh 离线调度任务设置 PI_UNATTENDED=1。
 * 定时任务进程虽加载扩展（可调 link_send），但属于无人值守执行——
 * 默认拒绝其跨设备指令，防"我在 A 干活时 A 的定时任务乱指挥 B"。
 */
export function isUnattendedEnv(): boolean {
  return process.env.PI_UNATTENDED === '1'
}

export function activeFilePath(): string {
  const env = process.env.PI_LINK_STATE_DIR
  if (env) return join(env, 'pi-link-active.json')
  return join(homedir(), '.pi', 'pi-link-active.json')
}

export function selfName(cfgName?: string): string {
  return cfgName || hostname()
}

export function readActive(file = activeFilePath()): ActiveState | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ActiveState>
    if (typeof raw.lastActiveAt !== 'number') return null
    return { device: String(raw.device ?? ''), lastActiveAt: raw.lastActiveAt, lastInput: raw.lastInput, lastSendAt: raw.lastSendAt }
  } catch {
    return null
  }
}

export function writeActive(state: Partial<ActiveState>, file = activeFilePath()): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const cur = readActive(file)
    writeFileSync(file, JSON.stringify({ ...(cur ?? {}), ...state, device: state.device ?? cur?.device ?? '' }, null, 2), 'utf-8')
  } catch {
    // 写失败不影响主流程
  }
}

/** 刷新活跃时间戳（用户输入时调用） */
export function touchActive(device: string, inputText?: string): void {
  writeActive({ device, lastActiveAt: Date.now(), lastInput: inputText?.slice(0, 100) })
}

/** 本机当前是否活跃（有近期用户交互） */
export function isActive(st?: ActiveState | null, windowMs = ACTIVE_WINDOW_MS): boolean {
  if (!st) return false
  return Date.now() - st.lastActiveAt < windowMs
}
