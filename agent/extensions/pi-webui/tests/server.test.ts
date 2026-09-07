import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock http and ws
const mockReq: any = {
  url: '/api/test',
  method: 'GET',
  headers: {},
}

const mockRes: any = {
  writeHead: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
}

const mockServer: any = {
  on: vi.fn(),
  listen: vi.fn((port: number, host: string, cb: () => void) => cb && cb()),
  close: vi.fn((cb: () => void) => cb && cb()),
}

vi.mock('node:http', () => ({
  createServer: vi.fn(() => mockServer),
  IncomingMessage: class {},
  ServerResponse: class {},
}))

vi.mock('ws', () => ({
  WebSocketServer: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
  WebSocket: class {
    readyState = 1
    send = vi.fn()
    close = vi.fn()
    on = vi.fn()
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '<html>Test</html>'),
    statSync: vi.fn(() => ({ isFile: () => true, size: 100 })),
  }
})

vi.mock('node:path', () => ({
  join: (...args: string[]) => args.join('/'),
  extname: (p: string) => p.slice(p.lastIndexOf('.')),
}))

describe('server', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockReq.url = '/api/test'
    mockReq.method = 'GET'
    mockReq.headers = {}
    mockRes.writeHead.mockReset()
    mockRes.end.mockReset()
  })

  it('should create server with correct context', async () => {
    const { createWebuiServer, mergeDeviceStatuses } = await import('../server')
    
    const mockHub: any = {
      getAllDeviceStatus: vi.fn(() => [{ name: 'device1', online: true }]),
    }
    
    const mockBridge: any = {
      getDeviceStatus: vi.fn(() => [{ name: 'device2', online: true, error: undefined }]),
    }
    
    const ctx: any = {
      config: {
        port: 3100,
        host: '0.0.0.0',
        authToken: 'test-token',
        maxMessageHistory: 1000,
        enableFileUpload: false,
        uploadDir: '',
      },
      hub: mockHub,
      staticDir: '/static',
      selfDevice: 'localhost',
      bridge: mockBridge,
    }
    
    const server = createWebuiServer(ctx)
    expect(server).toBeDefined()
  })

  it('should merge device statuses correctly', async () => {
    const { mergeDeviceStatuses } = await import('../server')
    
    const mockHub: any = {
      getAllDeviceStatus: vi.fn(() => [
        { name: 'device1', online: true },
        { name: 'user', online: true }, // browser placeholder
      ]),
    }
    
    const mockBridge: any = {
      getDeviceStatus: vi.fn(() => [
        { name: 'device1', online: true, error: undefined },
        { name: 'device2', online: false, error: 'timeout' },
      ]),
    }
    
    const result = mergeDeviceStatuses(mockHub, mockBridge, 'localhost')
    
    // Should have self, device1 (from both), device2 (from bridge)
    expect(result).toHaveLength(3)
    
    const self = result.find((d: any) => d.name === 'localhost')
    expect(self).toBeDefined()
    expect(self!.online).toBe(true)
    expect(self!.wsConnected).toBe(true)
    
    const d1 = result.find((d: any) => d.name === 'device1')
    expect(d1).toBeDefined()
    expect(d1!.wsConnected).toBe(true)
    expect(d1!.sshConnected).toBe(true)
    
    const d2 = result.find((d: any) => d.name === 'device2')
    expect(d2).toBeDefined()
    expect(d2!.online).toBe(false)
    expect(d2!.sshConnected).toBe(false)
    expect(d2!.error).toBe('timeout')
  })

  it('should filter out browser placeholder "user"', async () => {
    const { mergeDeviceStatuses } = await import('../server')
    
    const mockHub: any = {
      getAllDeviceStatus: vi.fn(() => [
        { name: 'user', online: true },
      ]),
    }
    
    const mockBridge: any = {
      getDeviceStatus: vi.fn(() => []),
    }
    
    const result = mergeDeviceStatuses(mockHub, mockBridge, 'localhost')
    
    // Should only have self (localhost)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('localhost')
  })

  it('should check auth via Bearer token', async () => {
    const { checkAuth } = await import('../server')
    
    const config: any = { authToken: 'test-token' }
    
    const reqWithBearer = { ...mockReq, headers: { authorization: 'Bearer test-token' } }
    expect(checkAuth(reqWithBearer, config)).toBe(true)
    
    const reqWithWrongBearer = { ...mockReq, headers: { authorization: 'Bearer wrong-token' } }
    expect(checkAuth(reqWithWrongBearer, config)).toBe(false)
    
    const reqWithQueryToken = {
      ...mockReq,
      headers: {},
      url: '/api/test?token=test-token',
    }
    expect(checkAuth(reqWithQueryToken, config)).toBe(true)
    
    const reqNoAuth = { ...mockReq, headers: {}, url: '/api/test' }
    expect(checkAuth(reqNoAuth, config)).toBe(false)
  })

  it('should allow all when no authToken configured', async () => {
    const { checkAuth } = await import('../server')
    
    const config: any = { authToken: '' }
    const reqNoAuth = { ...mockReq, headers: {}, url: '/api/test' }
    expect(checkAuth(reqNoAuth, config)).toBe(true)
  })

  it('should serve static files', async () => {
    const { serveStatic } = await import('../server')
    
    const req = { ...mockReq, url: '/index.html' }
    const res = { ...mockRes }
    
    const result = serveStatic(req, res, '/static')
    
    expect(result).toBe(true)
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html; charset=utf-8' })
    expect(res.end).toHaveBeenCalled()
  })

  it('should fallback to index.html for SPA routes', async () => {
    const { serveStatic } = await import('../server')
    
    const req = { ...mockReq, url: '/chat/device1' }
    const res = { ...mockRes }
    
    const result = serveStatic(req, res, '/static')
    
    expect(result).toBe(true)
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html; charset=utf-8' })
  })
})
