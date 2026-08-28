import { homedir } from 'node:os'
import { writeFileSync, mkdirSync, readFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
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

/** 锁等待上限：超过视为陈锁（持有者已死/异常退出），强制接管 */
const LOCK_TIMEOUT_MS = 500
/** 自旋轮询间隔（同步休眠，阻塞当前线程但不烧 CPU） */
const LOCK_POLL_MS = 5

function sleepSync(ms: number): void {
  try {
    // Node 主线程允许 Atomics.wait：真睡眠不烧 CPU；不可用时退化为自旋
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) { /* 自旋兑底 */ }
  }
}

/**
 * 审计 MEDIUM（2026-08-26）：writeLocalState/writeActive 为无锁 read-merge-write——
 * 多实例（主 TUI + 后台 pi / pi-cron 离线进程）并发时互相覆盖丢更新。
 * 最小修复：同目录 `<file>.lock` O_EXCL 原子创建互斥，自旋等待 ≤LOCK_TIMEOUT_MS，
 * 陈锁强制接管（删后重试一次），不破坏现有 API（同步调用签名不变）。
 * 返回 fn() 结果；锁不可得时降级无锁继续（状态写入不阻塞主流程）。
 */
export function withStateLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`
  const start = Date.now()
  let fd: number | null = null
  let owned = false
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx') // O_EXCL：原子创建，已存在则 EEXIST
      owned = true
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') break // 目录缺失等非竞争错误：无锁继续（外层 try 兑错）
      if (Date.now() - start >= LOCK_TIMEOUT_MS) {
        // 陈锁强制接管：删除后重试一次；仍被抢走则无锁继续（不误删他人新锁）
        try { unlinkSync(lockPath) } catch { /* ignore */ }
        try { fd = openSync(lockPath, 'wx'); owned = true } catch { /* ignore */ }
        break
      }
      sleepSync(LOCK_POLL_MS)
    }
  }
  try {
    return fn()
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
    if (owned) { try { unlinkSync(lockPath) } catch { /* ignore */ } }
  }
}

export function writeLocalState(partial: Partial<LocalState>): void {
  try {
    const file = localStateFilePath()
    mkdirSync(join(file, '..'), { recursive: true })
    withStateLock(file, () => {
      let cur: Partial<LocalState> = {}
      try {
        cur = JSON.parse(readFileSync(file, 'utf-8'))
      } catch {
        // 首次写入
      }
      const next: LocalState = {
        device: partial.device ?? cur.device ?? '',
        status: partial.status ?? cur.status ?? 'idle',
        // 审计：idle 回写不清 currentTask 致陈旧任务名一直展示（远程 watch/attach
        // 看到早已结束的任务）。partial 未带 currentTask 且状态为 idle 时显式置
        // undefined（序列化时省略）；busy 时保留旧值属预期（同一任务运行中）。
        currentTask: partial.currentTask
          ?? ((partial.status ?? cur.status ?? 'idle') === 'idle' ? undefined : cur.currentTask),
        tmuxSession: partial.tmuxSession ?? cur.tmuxSession,
        currentSessionFile: partial.currentSessionFile ?? cur.currentSessionFile,
        updatedAt: Date.now(),
      }
      const tmp = file + '.tmp.' + process.pid
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
      renameSync(tmp, file)
    })
  } catch {
    // 写失败不影响主流程
  }
}
