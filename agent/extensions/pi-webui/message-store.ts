/**
 * pi-webui — 消息持久化 (JSON 文件)
 *
 * 消息按 chatId 分文件存储（~/.pi/webui/messages/）:
 *   group.json            群聊
 *   <对方设备名>.json      私聊（与前端会话 id 对齐）
 * 文件名用 encodeURIComponent 编码，与 chatId 双向可逆（设备名可含 - _ 等字符）。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ChatMessage } from './types.ts'

const MSG_DIR = join(homedir(), '.pi', 'webui', 'messages')
let maxHistory = 1000

export function setMaxHistory(n: number): void {
  maxHistory = Math.max(100, n)
}

function msgFilePath(chatId: string): string {
  // 用 encodeURIComponent 而非 `:`→`_` 替换：后者与 listChatIds 的反向映射不可逆，
  // chatId 改为设备名后会把 "a_b" 误还原为 "a:b"
  return join(MSG_DIR, `${encodeURIComponent(chatId)}.json`)
}

function ensureDir(): void {
  mkdirSync(MSG_DIR, { recursive: true })
}

interface StoreFile {
  chatId: string
  messages: ChatMessage[]
}

function readStore(chatId: string): ChatMessage[] {
  const p = msgFilePath(chatId)
  if (!existsSync(p)) return []
  try {
    const raw = readFileSync(p, 'utf-8')
    const data = JSON.parse(raw) as StoreFile
    return Array.isArray(data.messages) ? data.messages : []
  } catch {
    return []
  }
}

function writeStore(chatId: string, messages: ChatMessage[]): void {
  ensureDir()
  const p = msgFilePath(chatId)
  const data: StoreFile = { chatId, messages }
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf-8')
  renameSync(tmp, p)
}

/** 追加消息 */
export function appendMessage(msg: ChatMessage): ChatMessage {
  // chatId 统一为“对方设备名”（与前端私聊会话 id 对齐）：
  // 群聊→group；私聊→对方设备名（target 为某设备时即 target；target 为 user 即 agent 回复，取发送方设备名）
  const chatId = msg.target === null
    ? 'group'
    : msg.target === 'user' ? msg.senderDevice : msg.target
  const messages = readStore(chatId)
  messages.push(msg)
  while (messages.length > maxHistory) messages.shift()
  writeStore(chatId, messages)
  return msg
}

/** 读取历史消息 */
export function getMessages(chatId: string, opts?: { before?: number; limit?: number }): ChatMessage[] {
  let messages = readStore(chatId)
  if (opts?.before) {
    messages = messages.filter(m => m.ts < opts.before!)
  }
  const limit = opts?.limit ?? 50
  return messages.slice(-limit)
}

/** 删除一条消息（按 id） */
export function deleteMessage(chatId: string, id: string): boolean {
  const messages = readStore(chatId)
  const idx = messages.findIndex(m => m.id === id)
  if (idx === -1) return false
  messages.splice(idx, 1)
  writeStore(chatId, messages)
  return true
}

/** 清空一个聊天的所有消息 */
export function clearChat(chatId: string): number {
  const msgs = readStore(chatId)
  writeStore(chatId, [])
  return msgs.length
}

/** 获取所有有消息的 chatId 列表 */
export function listChatIds(): string[] {
  ensureDir()
  try {
    return readdirSync(MSG_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => decodeURIComponent(f.slice(0, -'.json'.length)))
  } catch {
    return []
  }
}
