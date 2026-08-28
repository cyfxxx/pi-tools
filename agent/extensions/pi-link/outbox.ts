import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 信箱条目：agent 一轮结束时的最终回复 */
export interface OutboxEntry {
  ts: number
  text: string
}

export const OUTBOX_MAX = 10

export function outboxFilePath(): string {
  // 审计：与 state.ts 对齐支持 PI_LINK_STATE_DIR 重定向（测试/多实例隔离）——
  // 此前仅状态/活跃文件重定向，outbox 仍固定写真实 ~/.pi，测试污染且多实例互踩
  const env = process.env.PI_LINK_STATE_DIR
  if (env) return join(env, 'pi-link-outbox.json')
  return join(homedir(), '.pi', 'pi-link-outbox.json')
}

export function readOutbox(): OutboxEntry[] {
  try {
    const raw = readFileSync(outboxFilePath(), 'utf8')
    const d = JSON.parse(raw)
    return Array.isArray(d?.entries) ? d.entries : []
  } catch {
    return []
  }
}

/** 追加一条回复到信箱（环形缓冲，超出丢弃最旧）。失败静默——不打断 agent。 */
export function appendOutbox(device: string, text: string): void {
  try {
    mkdirSync(dirname(outboxFilePath()), { recursive: true })
    const entries = readOutbox()
    entries.push({ ts: Date.now(), text })
    while (entries.length > OUTBOX_MAX) entries.shift()
    const p = outboxFilePath()
    // 审计 LOW：read-modify-write 原地写非原子——并发 append/读取方可能读到半截 JSON；
    // tmp+rename 原子替换（随机后缀防同进程重入/多实例互踩）
    const tmp = `${p}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify({ device, entries }, null, 2))
    renameSync(tmp, p)
  } catch {
    // 静默失败
  }
}

/** 从 agent_end 消息列表提取最终回复文本 */
export function extractFinalReply(messages: unknown[]): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const last = [...messages].reverse().find((m) => {
    const msg = m as { role?: string; content?: unknown }
    return (
      msg?.role === 'assistant' &&
      Array.isArray(msg.content) &&
      (msg.content as Array<{ type?: string; text?: string }>).some((c) => c?.type === 'text' && c.text?.trim())
    )
  })
  if (!last) return undefined
  const text = ((last as { content: Array<{ type?: string; text?: string }> }).content)
    .filter((c) => c?.type === 'text' && c.text?.trim())
    .map((c) => c.text)
    .join('\n')
    .trim()
  return text || undefined
}
