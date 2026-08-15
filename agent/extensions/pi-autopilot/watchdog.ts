import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { writeRestartRequest } from './state.ts'

const AGENT_DIR = getAgentDir()

let lastActivity = Date.now()

// 回合进行中豁免：单次长静默工具/subagent 执行（>30min 无输出）期间 lastActivity 与
// 会话文件 mtime 均不刷新，旧实现会误判挂死并 process.exit 杀主会话（审计实测）。
// 挂死检测的目标是"会话整体无响应"，不是"单回合长"——busy 时不判挂死。
// 审计 MEDIUM：豁免必须有上限——turn 内真挂死（turn_end/agent_settled 永不发出）
// 时 busyTurn 永久为 true、watchdog 永久失效；超 2×maxIdleMinutes 后豁免失效。
let busyTurn = false
let busySince = 0

const BUSY_GRACE_MULTIPLIER = 2

export function setTurnBusy(busy: boolean): void {
  busyTurn = busy
  busySince = busy ? Date.now() : 0
}

export function isTurnBusy(): boolean {
  return busyTurn
}

export function touchActivity(): void {
  lastActivity = Date.now()
}

export function lastActivityTs(): number {
  return lastActivity
}

// 挂死判定：距上次活动超过 maxIdleMinutes（now 可注入便于测试）
// 两个信号需同时超时才判挂死：
//   1. lastActivity 超时（session_start / input / 任务执行会刷新）
//   2. 最新会话文件 mtime 超时（LLM 写消息会刷新 mtime，用于长生成期间的兜底）
// 这样可避免启动初期：lastActivity 新鲜、但会话文件尚未创建/仍是旧文件时误报挂死
export async function isHanging(maxIdleMinutes: number, now: number = Date.now()): Promise<boolean> {
  if (maxIdleMinutes <= 0) return false
  // 回合进行中（长工具执行）豁免：turn_start 置 busy、turn_end/agent_settled 清除；
  // 豁免有上限（2×maxIdleMinutes）——turn 内真挂死时事件不再发出，超限后恢复判定
  if (busyTurn && busySince > 0 && now - busySince <= maxIdleMinutes * 60 * 1000 * BUSY_GRACE_MULTIPLIER) {
    return false
  }
  const idle = now - lastActivity
  if (idle <= maxIdleMinutes * 60 * 1000) return false
  // 兜底：会话文件 mtime（仅当 lastActivity 已超时才作佐证）
  try {
    const sessionFile = await latestSessionFile()
    if (sessionFile) {
      const st = await stat(sessionFile)
      if (now - st.mtimeMs <= maxIdleMinutes * 60 * 1000) return false
    }
  } catch { /* ignore */ }
  return true
}

async function latestSessionFile(): Promise<string | null> {
  const base = join(AGENT_DIR, 'sessions')
  const { readdir } = await import('node:fs/promises')
  let dirs: string[]
  try {
    dirs = await readdir(base)
  } catch {
    return null
  }
  let best: string | null = null
  let bestMtime = 0
  for (const dir of dirs) {
    const full = join(base, dir)
    try {
      const st = await stat(full)
      if (!st.isDirectory()) continue
      const files = await readdir(full)
      for (const f of files.filter(x => x.endsWith('.jsonl'))) {
        const fp = join(full, f)
        const fst = await stat(fp)
        if (fst.mtimeMs > bestMtime) {
          bestMtime = fst.mtimeMs
          best = fp
        }
      }
    } catch { /* ignore */ }
  }
  return best
}

// 触发挂死恢复：写重启请求，返回是否触发了恢复
export async function triggerHangRecovery(maxIdleMinutes: number, now: number = Date.now()): Promise<boolean> {
  if (!(await isHanging(maxIdleMinutes, now))) return false
  const idleMinutes = Math.round((now - lastActivity) / 60000)
  writeRestartRequest('restart_hang', {
    reason: `会话挂死（${idleMinutes} 分钟无活动），自动重启恢复`,
  })
  return true
}
