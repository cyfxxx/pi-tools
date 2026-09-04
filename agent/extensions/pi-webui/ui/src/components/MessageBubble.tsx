/**
 * 消息气泡
 */

import { useState, useCallback } from 'react'
import type { ChatMessage } from '../lib/types'
import { MessageContent } from './MessageContent'

interface MessageBubbleProps {
  message: ChatMessage
  onDeleted?: () => void
  onQuote?: (msg: ChatMessage) => void
}

export function MessageBubble({ message, onDeleted, onQuote }: MessageBubbleProps) {
  const isSelf = message.sender === 'user'
  const isAgent = message.metadata?.piReplied
  const [showActions, setShowActions] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).catch(() => {})
  }, [message.content])

  const handleDelete = useCallback(() => {
    fetch(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' })
      .then(res => res.json())
      .then((data: { ok: boolean }) => {
        if (data.ok && onDeleted) onDeleted()
      })
  }, [message.id, onDeleted])

  const handleQuote = useCallback(() => {
    onQuote?.(message)
  }, [message, onQuote])

  const displayName = isAgent
    ? `[pi] ${message.senderDevice}`
    : message.senderDevice

  return (
    <div
      className={`message ${isSelf ? 'self' : isAgent ? 'agent' : 'other'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isSelf && (
        <div className="message-sender">{displayName}</div>
      )}
      <div className="message-bubble">
        <MessageContent content={message.content} />
        <div className="message-time">{formatTime(message.ts)}</div>
      </div>
      {showActions && (
        <div className="message-actions-bar">
          <button
            className="message-action-btn"
            title="复制消息"
            onClick={handleCopy}
          >
            📋
          </button>
          <button
            className="message-action-btn"
            title="引用消息"
            onClick={handleQuote}
          >
            ↪️
          </button>
          <button
            className="message-action-btn"
            title="删除消息"
            onClick={handleDelete}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * 格式化时间
 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  const time = d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })

  if (isToday) return time

  return d.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }) + ' ' + time
}