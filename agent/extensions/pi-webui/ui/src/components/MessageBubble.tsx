/**
 * 消息气泡
 */

import type { ChatMessage } from '../lib/types'

interface MessageBubbleProps {
  message: ChatMessage
  selfDevice: string
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isSelf = message.sender === 'user'
  const isAgent = message.metadata?.piReplied

  const className = `message ${isSelf ? 'self' : isAgent ? 'agent' : 'other'}`

  return (
    <div className={className}>
      {!isSelf && (
        <div className="message-sender">
          {isAgent ? `[pi] ${message.senderDevice}` : message.senderDevice}
        </div>
      )}
      <div className="message-bubble">
        {message.content}
      </div>
      <div className="message-time">
        {formatTime(message.ts)}
      </div>
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
