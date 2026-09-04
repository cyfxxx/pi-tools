/**
 * pi-webui 前端类型定义
 * 与后端 types.ts 保持一致
 */

export type MessageType = 'text' | 'image' | 'file' | 'system'

export interface ChatMessage {
  id: string
  ts: number
  sender: string
  senderDevice: string
  target: string | null
  type: MessageType
  content: string
  replyTo?: string
  metadata?: {
    piReplied?: boolean
    fileName?: string
    fileSize?: number
    mimeType?: string
  }
}

export type WsMessageType =
  | 'chat'
  | 'typing'
  | 'presence'
  | 'sync_request'
  | 'sync_response'
  | 'device_list'
  | 'ack'
  | 'delete'
  | 'clear'

export interface WsEnvelope<T = unknown> {
  type: WsMessageType
  payload: T
  ts: number
  fromDevice?: string
}

export interface DeviceStatus {
  name: string
  online: boolean
}

export interface TypingIndicator {
  chatId: string
  user: string
  ts: number
}

/** 聊天会话 */
export interface ChatSession {
  id: string        // "group" 或设备名
  name: string      // 显示名
  type: 'group' | 'private'
  unread: number
  lastMessage?: ChatMessage
}

/** 应用配置 */
export interface AppConfig {
  port: number
  host: string
  selfDevice: string
  enableFileUpload: boolean
}
