/**
 * pi-webui 主应用
 */

import { useState, useEffect, useCallback } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { fetchConfig } from './lib/api'
import type { ChatSession, AppConfig } from './lib/types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import './style.css'

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [authToken, setAuthToken] = useState('')
  const [activeSession, setActiveSession] = useState('group')
  const [sessions, setSessions] = useState<ChatSession[]>([
    { id: 'group', name: '群聊', type: 'group', unread: 0 },
  ])
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [wsInitialized, setWsInitialized] = useState(false)

  // 从 URL 获取 token
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const token = params.get('token') ?? ''
    setAuthToken(token)

    // 获取配置
    fetchConfig(token)
      .then(cfg => {
        setConfig(cfg)
        setWsInitialized(true)
      })
      .catch(() => {})
  }, [])

  // WebSocket 连接 - 只有在配置加载完成后才初始化
  const deviceName = wsInitialized && config ? 'user' : ''
  const {
    connected,
    messages,
    devices,
    typing,
    send,
    sendTyping,
    requestHistory,
  } = useWebSocket(activeSession, authToken, deviceName)

  // 根据设备列表更新会话列表
  useEffect(() => {
    setSessions(prev => {
      const group = prev.find(s => s.id === 'group') ?? {
        id: 'group',
        name: '群聊',
        type: 'group' as const,
        unread: 0,
      }

      const deviceSessions: ChatSession[] = devices.map(d => ({
        id: d.name,
        name: d.name,
        type: 'private' as const,
        unread: 0,
        lastMessage: prev.find(s => s.id === d.name)?.lastMessage,
      }))

      // 保留用户自定义的会话 (如果有)
      const custom = prev.filter(s => s.id !== 'group' && !devices.some(d => d.name === s.id))

      return [group, ...deviceSessions, ...custom]
    })
  }, [devices])

  // 更新会话的最后一条消息
  useEffect(() => {
    if (messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg) return

    setSessions(prev => prev.map(s => {
      if (s.id === 'group' && lastMsg.target === null) {
        return { ...s, lastMessage: lastMsg, unread: s.id === activeSession ? 0 : s.unread + 1 }
      }
      if (lastMsg.target === s.id || (lastMsg.sender === s.id && lastMsg.target === 'user')) {
        return { ...s, lastMessage: lastMsg, unread: s.id === activeSession ? 0 : s.unread + 1 }
      }
      return s
    }))
  }, [messages, activeSession])

  // 选择会话时清除未读
  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSession(sessionId)
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, unread: 0 } : s))
    setSidebarOpen(false)
    requestHistory(sessionId)
  }, [requestHistory])

  // 发送消息
  const handleSend = useCallback((text: string) => {
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      sender: 'user',
      senderDevice: config?.selfDevice ?? 'user',
      target: activeSession === 'group' ? null : activeSession,
      type: 'text' as const,
      content: text,
    }
    send(msg)
  }, [send, activeSession, config])

  // 正在输入
  const handleTyping = useCallback(() => {
    sendTyping(activeSession)
  }, [sendTyping, activeSession])

  if (!config) {
    return (
      <div className="app">
        <div className="empty-state">
          <div className="empty-state-icon">⏳</div>
          <div>加载中...</div>
        </div>
      </div>
    )
  }

  const activeSessionData = sessions.find(s => s.id === activeSession)

  return (
    <div className="app">
      <div className={`sidebar ${sidebarOpen ? '' : 'hidden'}`}>
        <Sidebar
          sessions={sessions}
          devices={devices}
          activeSession={activeSession}
          connected={connected}
          onSelect={handleSelectSession}
        />
      </div>
      <ChatView
        chatId={activeSession}
        chatName={activeSessionData?.name ?? activeSession}
        messages={messages}
        devices={devices}
        typing={typing}
        connected={connected}
        selfDevice={config.selfDevice}
        onSend={handleSend}
        onTyping={handleTyping}
        onBack={() => setSidebarOpen(true)}
      />
    </div>
  )
}