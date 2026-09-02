/**
 * pi-webui — pi agent 钩子
 *
 * 监听 pi agent 事件，将 agent 回复转换为聊天消息:
 * - agent_end: 捕获最终回复，作为 pi 的聊天消息广播
 * - input: 检测用户通过 WebUI 发送的消息
 *
 * 与 pi-voice 的区别:
 * - pi-voice 专注于语音输入/TTS 输出
 * - pi-webui 专注于多设备聊天室场景
 */

import type { ChatMessage } from './types.ts'

/** 从 agent_end 事件中提取最终回复文本 */
export function extractFinalReply(messages: unknown[]): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const last = [...messages].reverse().find((m) => {
    const msg = m as { role?: string; content?: unknown }
    return (
      msg?.role === 'assistant' &&
      Array.isArray(msg.content) &&
      (msg.content as Array<{ type?: string; text?: string }>).some(
        (c) => c?.type === 'text' && c.text?.trim()
      )
    )
  })
  if (!last) return undefined
  const text = (
    (last as { content: Array<{ type?: string; text?: string }> }).content
  )
    .filter((c) => c?.type === 'text' && c.text?.trim())
    .map((c) => c.text)
    .join('\n')
    .trim()
  return text || undefined
}

/** 判断消息是否为系统性回复 (不值得作为聊天消息展示) */
export function isTrivialReply(text: string): boolean {
  const trimmed = text.trim()
  // 纯工具调用结果、空回复、极短确认
  if (trimmed.length < 5) return true
  if (/^(ok|好的|done|完成|已执行)$/i.test(trimmed)) return true
  return false
}

/** 创建 agent 回复的聊天消息 */
export function createAgentReplyMessage(
  replyText: string,
  deviceName: string,
  targetChatId: string | null
): ChatMessage {
  return {
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    sender: deviceName,
    senderDevice: deviceName,
    target: targetChatId,
    type: 'text',
    content: replyText,
    metadata: { piReplied: true },
  }
}

/** 标记消息来源前缀 (便于区分人类消息和 agent 消息) */
export function agentReplyPrefix(): string {
  return '[pi] '
}
