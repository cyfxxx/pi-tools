import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock ws module
const mockWebSocket = {
  readyState: 1, // WebSocket.OPEN
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  addEventListener: vi.fn(),
}

vi.mock('ws', () => ({
  WebSocket: vi.fn(() => mockWebSocket),
  WebSocketServer: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}))

describe('ws-hub', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockWebSocket.readyState = 1
    mockWebSocket.send.mockReset()
    mockWebSocket.close.mockReset()
    mockWebSocket.on.mockReset()
  })

  it('should register a client and track device status', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws = { ...mockWebSocket }
    hub.register(ws, 'device1', false)
    
    const online = hub.getOnlineDevices()
    expect(online).toContain('device1')
    
    const status = hub.getAllDeviceStatus()
    expect(status).toContainEqual({ name: 'device1', online: true })
  })

  it('should not count user connections as devices', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws = { ...mockWebSocket }
    hub.register(ws, 'user', true)
    
    const online = hub.getOnlineDevices()
    expect(online).not.toContain('user')
  })

  it('should broadcast message to all clients', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws1 = { ...mockWebSocket, send: vi.fn() }
    const ws2 = { ...mockWebSocket, send: vi.fn() }
    
    hub.register(ws1, 'device1', false)
    hub.register(ws2, 'device2', false)
    hub.register({ ...mockWebSocket, send: vi.fn() }, 'user', true)
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'device1',
      senderDevice: 'device1',
      content: 'Hello all',
      target: null,
      type: 'text' as const,
    }
    
    hub.broadcast(msg)
    
    expect(ws1.send).toHaveBeenCalled()
    expect(ws2.send).toHaveBeenCalled()
    
    const sentData = JSON.parse(ws1.send.mock.calls[0][0])
    expect(sentData.type).toBe('chat')
    expect(sentData.payload.content).toBe('Hello all')
  })

  it('should send message to specific device', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws1 = { ...mockWebSocket, send: vi.fn() }
    const ws2 = { ...mockWebSocket, send: vi.fn() }
    
    hub.register(ws1, 'device1', false)
    hub.register(ws2, 'device2', false)
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'user',
      content: 'Private msg',
      target: 'device1',
      type: 'text' as const,
    }
    
    hub.sendToDevice('device1', msg)
    
    expect(ws1.send).toHaveBeenCalled()
    expect(ws2.send).not.toHaveBeenCalled()
  })

  it('should handle client disconnect and update device status', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws = { ...mockWebSocket }
    let closeHandler: () => void
    
    ws.on.mockImplementation((event, handler) => {
      if (event === 'close') closeHandler = handler
    })
    
    hub.register(ws, 'device1', false)
    expect(hub.getOnlineDevices()).toContain('device1')
    
    // Trigger close
    closeHandler!()
    
    expect(hub.getOnlineDevices()).not.toContain('device1')
  })

  it('should send typing indicator', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws1 = { ...mockWebSocket, send: vi.fn() }
    const ws2 = { ...mockWebSocket, send: vi.fn() }
    
    hub.register(ws1, 'device1', false)
    hub.register(ws2, 'device2', false)
    
    hub.sendTyping('group', 'user', 'device1')
    
    expect(ws1.send).not.toHaveBeenCalled() // excluded
    expect(ws2.send).toHaveBeenCalled()
    
    const sentData = JSON.parse(ws2.send.mock.calls[0][0])
    expect(sentData.type).toBe('typing')
    expect(sentData.payload.chatId).toBe('group')
  })

  it('should broadcast device list', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws = { ...mockWebSocket, send: vi.fn() }
    hub.register(ws, 'device1', false)
    
    hub.broadcastDeviceList([{ name: 'device1', online: true }])
    
    expect(ws.send).toHaveBeenCalled()
    const sentData = JSON.parse(ws.send.mock.calls[0][0])
    expect(sentData.type).toBe('device_list')
    expect(sentData.payload).toEqual([{ name: 'device1', online: true }])
  })

  it('should send ack', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws = { ...mockWebSocket, send: vi.fn() }
    
    hub.sendAck(ws, 'chat', true, 'OK')
    
    expect(ws.send).toHaveBeenCalled()
    const sentData = JSON.parse(ws.send.mock.calls[0][0])
    expect(sentData.type).toBe('ack')
    expect(sentData.payload.ok).toBe(true)
    expect(sentData.payload.originalType).toBe('chat')
  })

  it('should track client count', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    expect(hub.clientCount).toBe(0)
    
    hub.register({ ...mockWebSocket }, 'device1', false)
    expect(hub.clientCount).toBe(1)
    
    hub.register({ ...mockWebSocket }, 'device2', false)
    expect(hub.clientCount).toBe(2)
    
    hub.register({ ...mockWebSocket }, 'user', true)
    expect(hub.clientCount).toBe(3)
  })

  it('should handle multiple clients per device', async () => {
    const { WsHub } = await import('../ws-hub')
    const hub = new WsHub()
    
    const ws1 = { ...mockWebSocket, send: vi.fn() }
    const ws2 = { ...mockWebSocket, send: vi.fn() }
    
    hub.register(ws1, 'device1', false)
    hub.register(ws2, 'device1', false)
    
    expect(hub.clientCount).toBe(2)
    expect(hub.getOnlineDevices()).toContain('device1')
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'user',
      senderDevice: 'user',
      content: 'Test',
      target: null,
      type: 'text' as const,
    }
    
    hub.broadcast(msg)
    
    expect(ws1.send).toHaveBeenCalled()
    expect(ws2.send).toHaveBeenCalled()
  })
})