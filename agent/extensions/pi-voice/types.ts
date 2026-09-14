/**
 * pi-voice types — shared types and utility functions used across the extension.
 */

import { execFile } from 'node:child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** 秒级时间戳（YYYYMMDD_HHMMSS），用于文件名排序/区分。同一秒内多次调用会碰撞，调用方须追加随机后缀保证唯一。 */
export function nowStamp(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 执行外部命令（argv 数组，无 shell 注入）。超时强制结束。 */
export function runCommand(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<CommandResult> {
  const { timeoutMs = 60000, maxBuffer = 16 * 1024 * 1024 } = opts
  return new Promise((resolvePromise) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      if (!err) {
        resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string }
      if (typeof e.code === 'number') {
        resolvePromise({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      if (e.message.includes('ENOENT')) {
        resolvePromise({ code: 127, stdout: '', stderr: `${bin}: command not found` })
        return
      }
      // Node v22 超时杀进程时 err.code=null、signal='SIGTERM'、killed=true，
      // message 不含 ETIMEDOUT——按 killed 判定超时（审计 LOW：e.signal==='SIGTERM'
      // 会把外部 SIGTERM 正常终止的进程也误报 timeout；killed 仅超时自杀时置 true）
      if (e.killed === true) {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? e.message })
    })
  })
}

export interface TranscribeResult {
  text: string
  language: string
  error?: string
}
