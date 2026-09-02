/**
 * pi-webui — 消息持久化 (JSON 文件)
 *
 * 消息按 chatId 分文件存储:
 *   ~/.pi/webui/messages/group.json
 *   ~/.pi/webui/messages/device:device.json
 *
 * 环形缓冲: 超过 maxHistory 条时裁剪最旧的
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
  const safe = chatId.replace(/:/g, '_')
  return join(MSG_DIR, `${safe}.json`)
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

function chatIdFromParticipants(a: string, b: string): string {
  return [a, b].sort().join(':')
}

/** 追加消息 */
export function appendMessage(msg: ChatMessage): ChatMessage {
  const chatId = msg.target === null
    ? 'group'
    : chatIdFromParticipants(msg.sender, msg.target === 'user' ? msg.senderDevice : msg.target)
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

/** 获取所有有消息的 chatId 列表 */
export function listChatIds(): string[] {
  ensureDir()
  try {
    return readdirSync(MSG_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', '').replace(/_/g, ':'))
  } catch {
    return []
  }
}
