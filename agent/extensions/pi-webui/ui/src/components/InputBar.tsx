/**
 * 输入框
 */

import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import type { ChatMessage } from '../lib/types'

interface InputBarProps {
  onSend: (text: string, replyTo?: string) => void
  onTyping: () => void
  disabled?: boolean
  placeholder?: string
  replyTo?: ChatMessage
  onClearReply?: () => void
}

export function InputBar({ onSend, onTyping, disabled, placeholder, replyTo, onClearReply }: InputBarProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout>>()

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed, replyTo?.id)
    setText('')
    onClearReply?.()
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSend, replyTo?.id, onClearReply])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && replyTo) {
      onClearReply?.()
    }
  }, [handleSend, replyTo, onClearReply])

  const handleChange = useCallback(() => {
    const value = textareaRef.current?.value ?? ''
    setText(value)

    // 自动调整高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }

    // 正在输入指示 (节流 1s)
    if (!typingTimer.current) {
      onTyping()
      typingTimer.current = setTimeout(() => {
        typingTimer.current = undefined
      }, 1000)
    }
  }, [onTyping])

  return (
    <div className="input-area">
      {replyTo && (
        <div className="reply-preview">
          <div className="reply-preview-sender">
            {replyTo.metadata?.piReplied ? `[pi] ${replyTo.senderDevice}` : replyTo.senderDevice}
          </div>
          <div className="reply-preview-content">{replyTo.content.slice(0, 60)}...</div>
          <button className="reply-preview-close" onClick={onClearReply} title="取消引用">×</button>
        </div>
      )}
      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          className="input-field"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? '输入消息... (Enter 发送, Shift+Enter 换行)'}
          rows={1}
        />
      </div>
      <button
        className="send-button"
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        title="发送"
      >
        ▶
      </button>
    </div>
  )
}