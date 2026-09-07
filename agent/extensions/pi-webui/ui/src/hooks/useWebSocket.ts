/**
 * WebSocket 连接管理 Hook
 *
 * 自动重连、消息解析、事件分发
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import type { ChatMessage, WsEnvelope, DeviceStatus, TypingIndicator } from '../lib/types'

export interface UseWebSocketReturn {
  connected: boolean
  messages: ChatMessage[]
  devices: DeviceStatus[]
  typing: TypingIndicator[]
  send: (msg: ChatMessage) => void
  sendTyping: (chatId: string) => void
  requestHistory: (chatId: string, before?: number) => void
  deleteMessage: (chatId: string, id: string) => Promise<boolean>
  clearChat: (chatId: string) => Promise<number>
}

export function useWebSocket(
  chatId: string,
  deviceName: string
): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [typing, setTyping] = useState<TypingIndicator[]>([])
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  const connect = useCallback(() => {
    if (!deviceName) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({
      device: deviceName,
      user: '1',
    })
    const url = `${protocol}//${location.host}/ws?${params}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({
        type: 'sync_request',
        payload: { chatId: chatIdRef.current, limit: 50 },
        ts: Date.now(),
      }))
    }

    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as WsEnvelope
        handleEnvelope(envelope)
      } catch {}
    }

    ws.onclose = () => {
      setConnected(false)
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [deviceName])

  const handleEnvelope = useCallback((envelope: WsEnvelope) => {
    switch (envelope.type) {
      case 'chat': {
        const msg = envelope.payload as ChatMessage
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev
          return [...prev, msg]
        })
        break
      }
      case 'device_list': {
        setDevices(envelope.payload as DeviceStatus[])
        break
      }
      case 'presence': {
        const { device, online } = envelope.payload as { device: string; online: boolean }
        setDevices(prev => {
          const exists = prev.find(d => d.name === device)
          if (exists) {
            return prev.map(d => d.name === device ? { ...d, online } : d)
          }
          return [...prev, { name: device, online }]
        })
        break
      }
      case 'typing': {
        const payload = envelope.payload as TypingIndicator
        setTyping(prev => {
          const filtered = prev.filter(t => !(t.chatId === payload.chatId && t.user === payload.user))
          return [...filtered, { ...payload, ts: Date.now() }]
        })
        setTimeout(() => {
          setTyping(prev => prev.filter(t => t.ts !== payload.ts))
        }, 3000)
        break
      }
      case 'sync_response': {
        const { messages: history, chatId: responseChatId } = envelope.payload as {
          messages: ChatMessage[]
          chatId: string
        }
        if (responseChatId === chatIdRef.current) {
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id))
            const newMsgs = history.filter(m => !existingIds.has(m.id))
            return [...newMsgs, ...prev]
          })
        }
        break
      }
    }
  }, [])

  const send = useCallback((msg: ChatMessage) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'chat',
      payload: msg,
      ts: Date.now(),
    }))
  }, [])

  const sendTyping = useCallback((chatId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'typing',
      payload: { chatId, user: 'user' },
      ts: Date.now(),
    }))
  }, [])

  const requestHistory = useCallback((chatId: string, before?: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'sync_request',
      payload: { chatId, before, limit: 50 },
      ts: Date.now(),
    }))
  }, [])

  const deleteMessage = useCallback(async (chatId: string, id: string): Promise<boolean> => {
    const res = await fetch(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const data = await res.json() as { ok: boolean }
    if (data.ok) requestHistory(chatId)
    return data.ok === true
  }, [requestHistory])

  const clearChat = useCallback(async (chatId: string): Promise<number> => {
    const res = await fetch(`/api/messages/clear?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
    const data = await res.json() as { deleted: number; ok?: boolean }
    if (data.ok !== false) requestHistory(chatId)
    return data.deleted ?? 0
  }, [requestHistory])

  useEffect(() => {
    setMessages([])
    if (connected) {
      requestHistory(chatId)
    }
  }, [chatId, connected, requestHistory])

  useEffect(() => {
    if (!deviceName) return
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect, deviceName])

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setTyping(prev => prev.filter(t => now - t.ts < 5000))
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  return { connected, messages, devices, typing, send, sendTyping, requestHistory, deleteMessage, clearChat }
}
