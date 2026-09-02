/**
 * pi-webui — WebSocket 连接管理 (Hub)
 *
 * 管理所有浏览器客户端连接，支持:
 * - 群聊广播
 * - 私聊定向发送
 * - 设备在线状态
 * - 正在输入指示
 */

import type { WebSocket } from 'ws'
import type { ChatMessage, WsEnvelope, WsMessageType, PresencePayload, TypingPayload } from './types.ts'

export interface ClientInfo {
  ws: WebSocket
  /** 连接的设备名 */
  device: string
  /** 是否为用户 (非 pi agent 设备) */
  isUser: boolean
  /** 连接时间 */
  connectedAt: number
}

export class WsHub {
  private clients = new Map<string, ClientInfo[]>()
  private deviceOnline = new Map<string, boolean>()

  /** 注册新客户端连接 */
  register(ws: WebSocket, device: string, isUser: boolean): void {
    const info: ClientInfo = { ws, device, isUser, connectedAt: Date.now() }
    const list = this.clients.get(device) ?? []
    list.push(info)
    this.clients.set(device, list)

    // 标记在线
    this.deviceOnline.set(device, true)
    this.broadcastPresence(device, true)

    ws.on('close', () => {
      const arr = this.clients.get(device)
      if (!arr) return
      const idx = arr.indexOf(info)
      if (idx !== -1) arr.splice(idx, 1)
      if (arr.length === 0) {
        this.clients.delete(device)
        this.deviceOnline.set(device, false)
        this.broadcastPresence(device, false)
      }
    })

    ws.on('error', () => {
      ws.close()
    })
  }

  /** 广播消息给所有连接的客户端 (群聊) */
  broadcast(msg: ChatMessage): void {
    const envelope: WsEnvelope<ChatMessage> = {
      type: 'chat',
      payload: msg,
      ts: Date.now(),
      fromDevice: msg.senderDevice,
    }
    const data = JSON.stringify(envelope)
    for (const [, clients] of this.clients) {
      for (const c of clients) {
        if (c.ws.readyState === 1) c.ws.send(data)
      }
    }
  }

  /** 发送给特定设备的客户端 (私聊) */
  sendToDevice(targetDevice: string, msg: ChatMessage): void {
    const envelope: WsEnvelope<ChatMessage> = {
      type: 'chat',
      payload: msg,
      ts: Date.now(),
      fromDevice: msg.senderDevice,
    }
    const data = JSON.stringify(envelope)
    const clients = this.clients.get(targetDevice)
    if (!clients) return
    for (const c of clients) {
      if (c.ws.readyState === 1) c.ws.send(data)
    }
  }

  /** 发送正在输入指示 */
  sendTyping(chatId: string, user: string, excludeDevice?: string): void {
    const payload: TypingPayload = { chatId, user }
    const envelope: WsEnvelope<TypingPayload> = {
      type: 'typing',
      payload,
      ts: Date.now(),
    }
    const data = JSON.stringify(envelope)
    for (const [device, clients] of this.clients) {
      if (device === excludeDevice) continue
      for (const c of clients) {
        if (c.ws.readyState === 1) c.ws.send(data)
      }
    }
  }

  /** 发送设备列表更新 */
  broadcastDeviceList(devices: Array<{ name: string; online: boolean }>): void {
    const envelope: WsEnvelope<Array<{ name: string; online: boolean }>> = {
      type: 'device_list',
      payload: devices,
      ts: Date.now(),
    }
    const data = JSON.stringify(envelope)
    for (const [, clients] of this.clients) {
      for (const c of clients) {
        if (c.ws.readyState === 1) c.ws.send(data)
      }
    }
  }

  /** 发送 ack */
  sendAck(ws: WebSocket, originalType: WsMessageType, ok: boolean, detail?: string): void {
    const envelope: WsEnvelope<{ ok: boolean; detail?: string; originalType: WsMessageType }> = {
      type: 'ack',
      payload: { ok, detail, originalType },
      ts: Date.now(),
    }
    if (ws.readyState === 1) ws.send(JSON.stringify(envelope))
  }

  /** 获取所有在线设备 */
  getOnlineDevices(): string[] {
    const online: string[] = []
    for (const [device, isOnline] of this.deviceOnline) {
      if (isOnline) online.push(device)
    }
    return online
  }

  /** 获取所有设备及其在线状态 */
  getAllDeviceStatus(): Array<{ name: string; online: boolean }> {
    const result: Array<{ name: string; online: boolean }> = []
    const seen = new Set<string>()
    for (const [device, isOnline] of this.deviceOnline) {
      result.push({ name: device, online: isOnline })
      seen.add(device)
    }
    return result
  }

  /** 获取连接总数 */
  get clientCount(): number {
    let n = 0
    for (const clients of this.clients.values()) n += clients.length
    return n
  }

  private broadcastPresence(device: string, online: boolean): void {
    const payload: PresencePayload = { device, online }
    const envelope: WsEnvelope<PresencePayload> = {
      type: 'presence',
      payload,
      ts: Date.now(),
    }
    const data = JSON.stringify(envelope)
    for (const [, clients] of this.clients) {
      for (const c of clients) {
        if (c.ws.readyState === 1) c.ws.send(data)
      }
    }
  }
}
