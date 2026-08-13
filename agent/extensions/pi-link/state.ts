import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 远程设备状态（T2-2）
 *
 * 每台设备的 pi-link 扩展维护 ~/.pi/pi-link-state.json：
 * - status: idle | busy（agent 是否在运行）
 * - currentTask: 当前任务摘要（turn 期间 user 消息前 100 字符）
 * - tmuxSession: 远程 pi 所在的 tmux 会话名（attach 用）
 * - currentSessionFile: 当前会话文件路径（watch 用）
 * 本机经 ssh 读取远程状态做冲突防护（busy 时拒绝 attach，可 --force）。
 */

export interface DeviceState {
  device: string
  status: 'idle' | 'busy'
  currentTask?: string
  tmuxSession?: string
  currentSessionFile?: string
  updatedAt: number
}

export function stateFilePath(): string {
  const env = process.env.PI_LINK_STATE_DIR
  if (env) return join(env, 'pi-link-state.json')
  return join(homedir(), '.pi', 'pi-link-state.json')
}

export function parseState(raw: string): DeviceState | null {
  try {
    const d = JSON.parse(raw) as Partial<DeviceState>
    if (d.status !== 'idle' && d.status !== 'busy') return null
    return {
      device: String(d.device ?? ''),
      status: d.status,
      currentTask: typeof d.currentTask === 'string' ? d.currentTask : undefined,
      tmuxSession: typeof d.tmuxSession === 'string' ? d.tmuxSession : undefined,
      currentSessionFile: typeof d.currentSessionFile === 'string' ? d.currentSessionFile : undefined,
      updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

