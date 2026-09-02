/**
 * 聊天视图 — 消息流 + 输入框
 */

import { useEffect, useRef } from 'react'
import type { ChatMessage, DeviceStatus, TypingIndicator } from '../lib/types'
import { MessageBubble } from './MessageBubble'
import { InputBar } from './InputBar'

interface ChatViewProps {
  chatId: string
  chatName: string
  messages: ChatMessage[]
  devices: DeviceStatus[]
  typing: TypingIndicator[]
  connected: boolean
  selfDevice: string
  onSend: (text: string) => void
  onTyping: () => void
  onBack?: () => void
}

export function ChatView({
  chatId,
  chatName,
  messages,
  devices,
  typing,
  connected,
  selfDevice,
  onSend,
  onTyping,
  onBack,
}: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [messages])

  // 过滤当前聊天的消息
  const filteredMessages = messages.filter(msg => {
    if (chatId === 'group') {
      return msg.target === null
    }
    // 私聊: 双方之间的消息
    return (
      (msg.senderDevice === chatId && msg.target === 'user') ||
      (msg.sender === 'user' && msg.senderDevice === selfDevice && msg.target === chatId)
    )
  })

  // 当前聊天的 typing 指示
  const chatTyping = typing.filter(t => t.chatId === chatId && t.user !== 'user')

  // 在线设备数
  const onlineCount = devices.filter(d => d.online).length

  return (
    <div className="chat-area">
      <div className="chat-header">
        {onBack && (
          <button className="back-button" onClick={onBack}>←</button>
        )}
        <div>
          <div className="chat-header-title">{chatName}</div>
          <div className="chat-header-status">
            {chatId === 'group'
              ? `${onlineCount} 台设备在线`
              : devices.some(d => d.name === chatId && d.online) ? '在线' : '离线'}
            {!connected && ' · 连接中...'}
          </div>
        </div>
      </div>

      <div className="messages-container" ref={containerRef}>
        {filteredMessages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <div>暂无消息</div>
          </div>
        ) : (
          filteredMessages.map(msg => (
            <MessageBubble
              key={msg.id}
              message={msg}
              selfDevice={selfDevice}
            />
          ))
        )}
      </div>

      <div className="typing-indicator">
        {chatTyping.length > 0 && (
          <span>{chatTyping.map(t => t.user).join(', ')} 正在输入...</span>
        )}
      </div>

      <InputBar
        onSend={onSend}
        onTyping={onTyping}
        disabled={!connected}
        placeholder={chatId === 'group' ? '发送到群聊...' : `发送给 ${chatName}...`}
      />
    </div>
  )
}
