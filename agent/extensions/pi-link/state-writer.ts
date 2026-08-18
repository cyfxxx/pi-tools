import { homedir } from 'node:os'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 审计 MEDIUM 修复（2026-08-18）：本文件为 ESM 模块（package.json "type":"module"），
// 此前裸 require('node:fs') 抛 ReferenceError 被外层 catch 吞掉——读合并逻辑成死代码，
// 未传字段（currentTask/tmuxSession/currentSessionFile）每次写入静默丢失。改静态导入

/**
 * 本机状态文件写入（T2-2）：远程设备 attach/watch 时经 ssh 读取本机状态。
 * 写入路径与 state.ts 的读取路径一致（~/.pi/pi-link-state.json）。
 */

export interface LocalState {
  device: string
  status: 'idle' | 'busy'
  currentTask?: string
  tmuxSession?: string
  currentSessionFile?: string
  updatedAt: number
}

export function localStateFilePath(): string {
  const env = process.env.PI_LINK_STATE_DIR
  if (env) return join(env, 'pi-link-state.json')
  return join(homedir(), '.pi', 'pi-link-state.json')
}

export function writeLocalState(partial: Partial<LocalState>): void {
  try {
    const file = localStateFilePath()
    mkdirSync(join(file, '..'), { recursive: true })
    let cur: Partial<LocalState> = {}
    try {
      cur = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      // 首次写入
    }
    const next: LocalState = {
      device: partial.device ?? cur.device ?? '',
      status: partial.status ?? cur.status ?? 'idle',
      currentTask: partial.currentTask ?? cur.currentTask,
      tmuxSession: partial.tmuxSession ?? cur.tmuxSession,
      currentSessionFile: partial.currentSessionFile ?? cur.currentSessionFile,
      updatedAt: Date.now(),
    }
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    // 写失败不影响主流程
  }
}
