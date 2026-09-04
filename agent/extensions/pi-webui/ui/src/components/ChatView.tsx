/**
 * 聊天视图 — 消息流 + 输入框
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import type { ChatMessage, DeviceStatus, TypingIndicator } from '../lib/types'
import { MessageBubble } from './MessageBubble'
import { InputBar } from './InputBar'
import { SystemMessage } from './SystemMessage'

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
  onDeleted?: () => void
  onCleared?: () => void
  onQuote?: (msg: { id: string; content: string }) => void
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
  onDeleted,
  onCleared,
  onQuote,
}: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [clearing, setClearing] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const handleClearChat = useCallback(async () => {
    setClearing(true)
    try {
      await clearChat(chatId)
      onCleared?.()
    } finally {
      setClearing(false)
    }
  }, [chatId, onCleared])

  const handleDeleted = useCallback(() => {
    onDeleted?.()
  }, [onDeleted])

  // 滚动到底部按钮
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleScroll = () => {
      // 当用户手动滚动且未到底部时显示按钮
      const scrollFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(scrollFromBottom > 20)
    }
    el.addEventListener('scroll', handleScroll)
    // 初始化：滚动到底部
    el.scrollTop = el.scrollHeight
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
      setShowScrollBtn(false)
    }
  }, [])

  // 自动滚动到底部（新消息到达时）
  useEffect(() => {
    const el = containerRef.current
    if (el && !showScrollBtn) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, showScrollBtn])


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
        {filteredMessages.length > 0 && (
          <button
            className="clear-chat-btn"
            onClick={handleClearChat}
            disabled={clearing}
            style={{
              marginLeft: 'auto',
              padding: '4px 10px',
              fontSize: '0.8em',
              background: clearing ? '#ccc' : '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: 4,
              cursor: clearing ? 'wait' : 'pointer',
            }}
          >
            {clearing ? '清理中...' : `清空 ${chatId === 'group' ? '群聊' : chatName}聊天`}
          </button>
        )}
      </div>

      <div className="messages-container" ref={containerRef}>
        {filteredMessages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <div>暂无消息</div>
          </div>
        ) : (
          filteredMessages.map(msg => (
            msg.type === 'system' ? (
              <SystemMessage key={msg.id} message={msg} />
            ) : (
              <MessageBubble
                key={msg.id}
                message={msg}
                chatId={chatId}
                selfDevice={selfDevice}
                selfName={selfDevice}
                onDeleted={handleDeleted}
                onQuote={onQuote}
              />
            )
          ))
        )}
      </div>

      <div className="typing-indicator">
        {chatTyping.length > 0 && (
          <span>{chatTyping.map(t => t.user).join(', ')} 正在输入...</span>
        )}
      </div>

      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          title="滚动到底部"
          aria-label="滚动到底部"
        >
          ↓
        </button>
      )}

      <InputBar
        onSend={onSend}
        onTyping={onTyping}
        disabled={!connected}
        placeholder={chatId === 'group' ? '发送到群聊...' : `发送给 ${chatName}...`}
      />
    </div>
  )
}
