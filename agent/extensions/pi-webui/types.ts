/**
 * pi-webui — 消息协议与配置类型
 */

import type { DeviceConfig } from '../pi-link/config.ts'

// ── 消息 ──────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'file' | 'system'

export interface ChatMessage {
  id: string
  ts: number
  /** 发送者名称 (设备名 或 "user") */
  sender: string
  /** 发送设备 (hostname) */
  senderDevice: string
  /** 目标 (null=群聊, 设备名=私聊, "user"=回复用户) */
  target: string | null
  type: MessageType
  content: string
  /** 引用的消息 ID */
  replyTo?: string
  metadata?: {
    piReplied?: boolean
    fileName?: string
    fileSize?: number
    mimeType?: string
  }
}

// ── WebSocket 协议 ────────────────────────────────────

export type WsMessageType =
  | 'chat'           // 聊天消息
  | 'typing'         // 正在输入
  | 'presence'       // 在线状态
  | 'sync_request'   // 请求历史消息
  | 'sync_response'  // 历史消息响应
  | 'device_list'    // 设备列表更新
  | 'ack'            // 确认收到

export interface WsEnvelope<T = unknown> {
  type: WsMessageType
  payload: T
  ts: number
  /** 消息来源设备 (服务端填充) */
  fromDevice?: string
}

export interface TypingPayload {
  chatId: string     // 群聊 = "group", 私聊 = 对方设备名
  user?: string      // 用户名 (如果是用户在输入)
}

export interface PresencePayload {
  device: string
  online: boolean
}

export interface SyncRequestPayload {
  chatId: string
  before?: number    // 时间戳，分页用
  limit?: number     // 默认 50
}

export interface SyncResponsePayload {
  chatId: string
  messages: ChatMessage[]
  hasMore: boolean
}

// ── 配置 ──────────────────────────────────────────────

export interface WebuiConfig {
  port: number
  host: string
  authToken: string
  maxMessageHistory: number
  enableFileUpload: boolean
  uploadDir: string
}

export const DEFAULT_CONFIG: WebuiConfig = {
  port: 3100,
  host: '0.0.0.0',
  authToken: '',
  maxMessageHistory: 1000,
  enableFileUpload: false,
  uploadDir: '',
}

// ── 辅助函数 ──────────────────────────────────────────

export function chatIdForGroup(): string {
  return 'group'
}

export function chatIdForPrivate(a: string, b: string): string {
  return [a, b].sort().join(':')
}

export function chatIdParticipants(chatId: string): [string, string] | null {
  if (chatId === 'group') return null
  const parts = chatId.split(':')
  return parts.length === 2 ? [parts[0], parts[1]] : null
}
