import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    writeFileSync(outboxFilePath(), JSON.stringify({ device, entries }, null, 2))
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
