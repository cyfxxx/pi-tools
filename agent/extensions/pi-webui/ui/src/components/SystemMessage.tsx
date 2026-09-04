/**
 * 系统消息组件
 */

import type { ChatMessage } from '../lib/types'

interface SystemMessageProps {
  message: ChatMessage
}

export function SystemMessage({ message }: SystemMessageProps) {
  // 解析系统消息内容
  const { type, text } = parseSystemContent(message.content)

  return (
    <div className="system-message" role="status" aria-live="polite">
      <span className="system-icon">{type.icon}</span>
      <span className="system-text">{text}</span>
    </div>
  )
}

interface SystemContent {
  type: 'info' | 'join' | 'leave' | 'error' | 'warning'
  text: string
  icon: string
}

function parseSystemContent(content: string): SystemContent {
  // 尝试解析 JSON 格式的系统消息
  try {
    const data = JSON.parse(content)
    if (data.type === 'join') {
      return { type: 'join', text: `${data.name} 加入了聊天`, icon: '👋' }
    }
    if (data.type === 'leave') {
      return { type: 'leave', text: `${data.name} 离开了聊天`, icon: '👋' }
    }
    if (data.type === 'error') {
      return { type: 'error', text: data.text ?? '发生错误', icon: '⚠️' }
    }
    if (data.type === 'warning') {
      return { type: 'warning', text: data.text ?? '警告', icon: '⚠️' }
    }
    if (data.text) {
      return { type: 'info', text: data.text, icon: 'ℹ️' }
    }
  } catch {}

  // 兜底：纯文本
  return { type: 'info', text: content, icon: 'ℹ️' }
}