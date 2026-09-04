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

/** 提取一条消息里的纯文本（兼容 string 与 content block 数组） */
function messageText(m: unknown): string {
  const msg = m as { content?: unknown }
  if (Array.isArray(msg?.content)) {
    return (msg.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n').trim()
  }
  return typeof msg?.content === 'string' ? msg.content.trim() : ''
}

/** 折叠空白，用于注入文本与对话历史里的 user 消息比对 */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 本次 run 是否包含指定注入文本（user 消息） */
function containsUserText(messages: unknown[], injected: string): boolean {
  const want = normalizeText(injected)
  if (!want) return false
  return messages.some((m) => {
    if ((m as { role?: string })?.role !== 'user') return false
    const t = normalizeText(messageText(m))
    return t === want || t.includes(want) || want.includes(t)
  })
}

/** 一条 webui 注入消息的回复路由归属 */
export type TurnOrigin = 'group' | 'private'

/**
 * 回复门控：只把“由 webui 消息触发的 run”的回复发到聊天室。
 *
 * 为何需要：agent_end 对任何来源的运行都会触发（本地 TUI 输入、其他扩展注入等）。
 * 无条件广播会把 agent 的本地工作输出当聊天消息发出去，污染群聊/私聊记录，
 * 也会让回复落错会话。改用“注入登记 + 本次 run 文本配对”做确定性判定：
 * - sendUserMessage 前 mark() 登记注入文本与归属
 * - agent_end 时 claim()：本次 run 的 messages 包含哪条登记文本，就属于谁；
 *   一条也不包含 → 本次 run 不是 webui 触发的 → 不外发（登记保留等后续 run）
 * 不依赖“最近一次 target”全局变量，避开 followUp 异步排队的串话竞态。
 */
export class WebuiTurnGate {
  private pending: Array<{ text: string; origin: TurnOrigin; ts: number }> = []
  /** 登记上限：防止 run 异常终止导致条目永久堆积（仅内存，无正确性影响） */
  private static readonly MAX_PENDING = 50

  mark(injectedText: string, origin: TurnOrigin): void {
    this.pending.push({ text: injectedText, origin, ts: Date.now() })
    if (this.pending.length > WebuiTurnGate.MAX_PENDING) this.pending.shift()
  }

  /**
   * 本次 run 归属。命中一条或多条登记时全部出队（一次 run 可能连带回答多条
   * followUp，只产出一条最终回复），归属取最后一条；无命中返回 null。
   */
  claim(messages: unknown[]): TurnOrigin | null {
    if (this.pending.length === 0 || !Array.isArray(messages) || messages.length === 0) return null
    // 按下标删除，不用对象引用比对：entries 可能被别名/拷贝，引用比对会漏删导致重复回复
    const hitIdx: number[] = []
    for (let i = 0; i < this.pending.length; i++) {
      if (containsUserText(messages, this.pending[i].text)) hitIdx.push(i)
    }
    if (hitIdx.length === 0) return null
    const origin = this.pending[hitIdx[hitIdx.length - 1]].origin
    const remove = new Set(hitIdx)
    this.pending = this.pending.filter((_, i) => !remove.has(i))
    return origin
  }

  /** 会话切换/服务重启时清空登记 */
  reset(): void {
    this.pending = []
  }

  /** 出队最早的登记（兜底用：claim 未命中时按 FIFO 兜底，确保回复不丢） */
  shift(): TurnOrigin | null {
    const p = this.pending.shift()
    return p?.origin ?? null
  }

  get size(): number {
    return this.pending.length
  }
}

/**
 * 从对话历史判定来源标签（无门控登记时的兼容推断）：
 * 私聊标签 → 'private'；群聊标签或无标签 → 'group'。
 */
export function inferOriginFromHistory(messages: unknown[]): TurnOrigin {
  if (!Array.isArray(messages)) return 'group'
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string })?.role !== 'user') continue
    const text = messageText(messages[i])
    if (!text) continue
    return /^\[来自\s+.+的私聊\]/.test(text) ? 'private' : 'group'
  }
  return 'group'
}
