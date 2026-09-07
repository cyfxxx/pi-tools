import { describe, it, expect, beforeEach } from 'vitest'
import { extractFinalReply, isTrivialReply, createAgentReplyMessage, WebuiTurnGate } from '../pi-agent-hook'

describe('pi-agent-hook utilities', () => {
  it('extractFinalReply should return last assistant text', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'First reply' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Final reply' }] },
    ]
    const result = extractFinalReply(msgs)
    expect(result).toBe('Final reply')
  })

  it('extractFinalReply returns undefined when no assistant text', () => {
    const msgs = [{ role: 'user', content: 'Hi' }]
    const result = extractFinalReply(msgs as any)
    expect(result).toBeUndefined()
  })

  it('isTrivialReply identifies short or ok replies', () => {
    expect(isTrivialReply('ok')).toBe(true)
    expect(isTrivialReply('好的')).toBe(true)
    expect(isTrivialReply('Done')).toBe(true)
    expect(isTrivialReply('This is a normal reply')).toBe(false)
    expect(isTrivialReply('')).toBe(true)
  })

  it('createAgentReplyMessage constructs proper ChatMessage', () => {
    const msg = createAgentReplyMessage('Hello world', 'my-device', 'group')
    expect(msg.sender).toBe('my-device')
    expect(msg.senderDevice).toBe('my-device')
    expect(msg.target).toBe('group')
    expect(msg.content).toBe('Hello world')
    expect(msg.type).toBe('text')
    expect(msg.metadata?.piReplied).toBe(true)
    expect(typeof msg.id).toBe('string')
    expect(typeof msg.ts).toBe('number')
  })

  describe('WebuiTurnGate', () => {
    let gate: WebuiTurnGate
    beforeEach(() => {
      gate = new WebuiTurnGate()
    })

    it('marks and claims matching turn', () => {
      gate.mark('User says hi', 'group')
      const msgs = [
        { role: 'user', content: 'User says hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
      ]
      const origin = gate.claim(msgs as any)
      expect(origin).toBe('group')
    })

    it('returns null when no match', () => {
      gate.mark('Another message', 'private')
      const msgs = [{ role: 'assistant', content: [{ type: 'text', text: 'Reply' }] }]
      const origin = gate.claim(msgs as any)
      expect(origin).toBeNull()
    })

    it('clears pending after claim', () => {
      gate.mark('Msg', 'group')
      const msgs = [{ role: 'user', content: 'Msg' }]
      gate.claim(msgs as any)
      // No pending should remain
      const origin2 = gate.claim([] as any)
      expect(origin2).toBeNull()
    })
  })
})