import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock fs to control file operations
let mockFiles: Record<string, string> = {}
let mockDirs: Set<string> = new Set()

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => {
      if (p.includes('.pi/webui/messages/')) {
        return mockFiles[p] !== undefined
      }
      return actual.existsSync(p)
    },
    readFileSync: (p: string, ...args: any[]) => {
      if (p.includes('.pi/webui/messages/') && mockFiles[p] !== undefined) {
        return mockFiles[p]
      }
      return actual.readFileSync(p, ...args)
    },
    writeFileSync: (p: string, data: string) => {
      if (p.includes('.pi/webui/messages/')) {
        mockFiles[p] = data
        return
      }
      return actual.writeFileSync(p, data)
    },
    mkdirSync: (p: string, opts?: any) => {
      if (p.includes('.pi/webui/messages/')) {
        mockDirs.add(p)
        return
      }
      return actual.mkdirSync(p, opts)
    },
    renameSync: (oldP: string, newP: string) => {
      if (oldP.includes('.pi/webui/messages/') && mockFiles[oldP] !== undefined) {
        mockFiles[newP] = mockFiles[oldP]
        delete mockFiles[oldP]
        return
      }
      return actual.renameSync(oldP, newP)
    },
    readdirSync: (p: string) => {
      if (p.includes('.pi/webui/messages/')) {
        return Object.keys(mockFiles)
          .filter(f => f.startsWith(p) && f.endsWith('.json'))
          .map(f => f.slice(p.length))
      }
      return actual.readdirSync(p)
    },
  }
})

// Mock os
vi.mock('os', () => ({
  homedir: () => '/home/testuser',
}))

describe('message-store', () => {
  beforeEach(() => {
    mockFiles = {}
    mockDirs = new Set()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('should append and retrieve messages for group chat', async () => {
    const { appendMessage, getMessages, clearChat } = await import('../message-store')
    
    const msg1 = {
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Hello group',
      target: null,
      type: 'text' as const,
    }
    const msg2 = {
      id: '2',
      ts: 2000,
      sender: 'device2',
      senderDevice: 'device2',
      content: 'Hi from device2',
      target: null,
      type: 'text' as const,
    }

    appendMessage(msg1)
    appendMessage(msg2)

    const messages = getMessages('group')
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('Hello group')
    expect(messages[1].content).toBe('Hi from device2')
  })

  it('should handle private chat messages (target is device)', async () => {
    const { appendMessage, getMessages } = await import('../message-store')
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Private msg',
      target: 'device2',
      type: 'text' as const,
    }

    appendMessage(msg)

    // Chat ID should be the target device name
    const messages = getMessages('device2')
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Private msg')
  })

  it('should handle agent reply messages (target is user)', async () => {
    const { appendMessage, getMessages } = await import('../message-store')
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'device1',
      senderDevice: 'device1',
      content: 'Agent reply',
      target: 'user',
      type: 'text' as const,
    }

    appendMessage(msg)

    // Chat ID should be the sender device
    const messages = getMessages('device1')
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Agent reply')
  })

  it('should respect maxHistory limit', async () => {
    const { appendMessage, getMessages, setMaxHistory } = await import('../message-store')
    
    setMaxHistory(3)
    
    for (let i = 0; i < 5; i++) {
      appendMessage({
        id: String(i),
        ts: Date.now() + i,
        sender: 'user',
        senderDevice: 'device1',
        content: `Message ${i}`,
        target: null,
        type: 'text',
      })
    }

    const messages = getMessages('group')
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe('Message 2')
    expect(messages[2].content).toBe('Message 4')
  })

  it('should filter messages by before timestamp', async () => {
    const { appendMessage, getMessages } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Old',
      target: null,
      type: 'text',
    })
    appendMessage({
      id: '2',
      ts: 2000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'New',
      target: null,
      type: 'text',
    })

    const messages = getMessages('group', { before: 1500 })
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Old')
  })

  it('should limit returned messages', async () => {
    const { appendMessage, getMessages } = await import('../message-store')
    
    for (let i = 0; i < 10; i++) {
      appendMessage({
        id: String(i),
        ts: Date.now() + i,
        sender: 'user',
        senderDevice: 'device1',
        content: `Message ${i}`,
        target: null,
        type: 'text',
      })
    }

    const messages = getMessages('group', { limit: 3 })
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe('Message 7')
  })

  it('should delete a message by id', async () => {
    const { appendMessage, getMessages, deleteMessage } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Delete me',
      target: null,
      type: 'text',
    })
    appendMessage({
      id: '2',
      ts: 2000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Keep me',
      target: null,
      type: 'text',
    })

    const deleted = deleteMessage('group', '1')
    expect(deleted).toBe(true)

    const messages = getMessages('group')
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('2')
  })

  it('should return false when deleting non-existent message', async () => {
    const { appendMessage, deleteMessage } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Test',
      target: null,
      type: 'text',
    })

    const deleted = deleteMessage('group', 'nonexistent')
    expect(deleted).toBe(false)
  })

  it('should clear all messages in a chat', async () => {
    const { appendMessage, getMessages, clearChat } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Test',
      target: null,
      type: 'text',
    })

    const cleared = clearChat('group')
    expect(cleared).toBe(1)

    const messages = getMessages('group')
    expect(messages).toHaveLength(0)
  })

  it('should list all chat IDs', async () => {
    const { appendMessage, listChatIds } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Group',
      target: null,
      type: 'text',
    })
    appendMessage({
      id: '2',
      ts: 2000,
      sender: 'user',
      senderDevice: 'device1',
      content: 'Private',
      target: 'device2',
      type: 'text',
    })

    const chatIds = listChatIds()
    expect(chatIds).toContain('group')
    expect(chatIds).toContain('device2')
  })

  it('should handle special characters in chat IDs via encoding', async () => {
    const { appendMessage, getMessages, listChatIds } = await import('../message-store')
    
    appendMessage({
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'device-a_b',
      content: 'Special device',
      target: 'device-a_b',
      type: 'text',
    })

    // Chat ID with underscore should be encoded in file but decoded in list
    const chatIds = listChatIds()
    expect(chatIds).toContain('device-a_b')
    
    const messages = getMessages('device-a_b')
    expect(messages).toHaveLength(1)
  })
})