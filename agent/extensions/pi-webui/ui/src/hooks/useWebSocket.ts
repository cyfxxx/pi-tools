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
}

export function useWebSocket(
  chatId: string,
  authToken: string
): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [devices, setDevices] = useState<DeviceStatus[]>([])
  const [typing, setTyping] = useState<TypingIndicator[]>([])
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId

  // 连接 WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({
      device: 'user',
      user: '1',
      token: authToken,
    })
    const url = `${protocol}//${location.host}/ws?${params}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // 请求当前聊天的历史消息
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
      // 自动重连
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [authToken])

  const handleEnvelope = useCallback((envelope: WsEnvelope) => {
    switch (envelope.type) {
      case 'chat': {
        const msg = envelope.payload as ChatMessage
        setMessages(prev => {
          // 去重
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
          // 替换或追加
          const filtered = prev.filter(t => !(t.chatId === payload.chatId && t.user === payload.user))
          return [...filtered, { ...payload, ts: Date.now() }]
        })
        // 3s 后自动清除
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

  // 发送消息
  const send = useCallback((msg: ChatMessage) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'chat',
      payload: msg,
      ts: Date.now(),
    }))
  }, [])

  // 发送正在输入
  const sendTyping = useCallback((chatId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'typing',
      payload: { chatId, user: 'user' },
      ts: Date.now(),
    }))
  }, [])

  // 请求历史消息
  const requestHistory = useCallback((chatId: string, before?: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({
      type: 'sync_request',
      payload: { chatId, before, limit: 50 },
      ts: Date.now(),
    }))
  }, [])

  // 切换聊天时重新加载历史
  useEffect(() => {
    setMessages([])
    if (connected) {
      requestHistory(chatId)
    }
  }, [chatId, connected, requestHistory])

  // 连接管理
  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  // 定期清除过期 typing 指示
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      setTyping(prev => prev.filter(t => now - t.ts < 5000))
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  return { connected, messages, devices, typing, send, sendTyping, requestHistory }
}
