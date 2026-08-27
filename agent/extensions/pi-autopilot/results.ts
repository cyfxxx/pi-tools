/**
 * 任务结果跨设备同步（2026-08-27 用户需求）
 *
 * 每设备独立文件 memory/daily-results/results-<device>.jsonl（append-only，
 * git 入库共享）：任务每次完结（success/failed）追加一行，天然按设备分文件
 * 免 git 冲突。各设备 pull 后即可看到其他设备每日任务执行结果（含失败原因），
 * 消除信息不对称。细节：输出截断 500 字符控体积；超 2MB 轮转保留一代。
 *
 * 测试隔离：PI_DAILY_RESULTS_DIR 环境变量覆盖目录（对齐 PI_ADMIN_STATE_FILE 模式）。
 */
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'

const DEVICE_TAG = (process.env.PI_DEVICE_ID || hostname() || 'host').replace(/[^A-Za-z0-9._-]/g, '_')
const MAX_SIZE = 2 * 1024 * 1024

function resultsDir(): string {
  return process.env.PI_DAILY_RESULTS_DIR || join(homedir(), '.pi', 'memory', 'daily-results')
}

export function resultsFilePath(device = DEVICE_TAG): string {
  return join(resultsDir(), `results-${device}.jsonl`)
}

export interface TaskResultEntry {
  taskId: string
  taskName: string
  result: 'success' | 'failed'
  output: string
  durationMs?: number
}

/** 追加一条任务结果到共享文件（写入失败静默，不阻塞任务记账） */
export function appendTaskResult(entry: TaskResultEntry): void {
  try {
    const f = resultsFilePath()
    if (existsSync(f)) {
      const st = statSync(f)
      if (st.size > MAX_SIZE) {
        try { renameSync(f, `${f}.old`) } catch { /* 轮转失败忽略 */ }
      }
    }
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(
      f,
      JSON.stringify({
        ts: new Date().toISOString(),
        device: DEVICE_TAG,
        taskId: entry.taskId,
        taskName: entry.taskName,
        result: entry.result,
        output: (entry.output || '').slice(0, 500),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      }) + '\n',
      'utf8',
    )
  } catch { /* 结果记录失败静默 */ }
}