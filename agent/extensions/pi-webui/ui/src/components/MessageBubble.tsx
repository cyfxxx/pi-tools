/**
 * 消息气泡
 */

import { useState } from 'react'
import type { ChatMessage } from '../lib/types'
import { deleteMessage } from '../hooks/deleteMessage'
import { clearChat } from '../hooks/clearChat'

interface MessageBubbleProps {
  message: ChatMessage
  chatId: string
  selfDevice: string
  onDeleted?: () => void
}

export function MessageBubble({ message, selfDevice, chatId, onDeleted }: MessageBubbleProps) {
  const isSelf = message.sender === 'user'
  const isAgent = message.metadata?.piReplied

  const className = `message ${isSelf ? 'self' : isAgent ? 'agent' : 'other'}`
  const [menuOpen, setMenuOpen] = useState(false)

  const handleDelete = async () => {
    setMenuOpen(false)
    const ok = await deleteMessage(chatId ?? 'group', message.id)
    if (ok && onDeleted) onDeleted()
  }

  return (
    <div className={className} onClick={() => setMenuOpen(!menuOpen)}>
      {!isSelf && (
        <div className="message-sender">
          {isAgent ? `[pi] ${message.senderDevice}` : message.senderDevice}
        </div>
      )}
      <div className="message-bubble">
        {message.content}
        <div className="message-actions" style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <span className="message-time" style={{ fontSize: '0.75em', opacity: 0.7 }}>
            {formatTime(message.ts)}
          </span>
        </div>
      </div>
      {menuOpen && (
        <div
          className="message-menu"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 6,
            padding: '4px 0',
            minWidth: 100,
            zIndex: 10,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <button
            onClick={handleDelete}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'none',
              padding: '6px 12px',
              cursor: 'pointer',
              color: '#d32f2f',
              fontSize: '0.85em',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          >
            🗑 删除
          </button>
        </div>
      )}
    </div>
  )
}

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
