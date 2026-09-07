import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.useFakeTimers()

// Mock child_process
const mockStdout = { on: vi.fn() }
const mockStderr = { on: vi.fn() }
const mockStdin = { write: vi.fn() }
const mockProcess = {
  stdin: mockStdin,
  stdout: mockStdout,
  stderr: mockStderr,
  on: vi.fn(),
  kill: vi.fn(),
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProcess),
}))

// Mock fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({
    devices: {
      device1: { user: 'user', host: 'host1', port: 22 },
      device2: { user: 'user', host: 'host2', port: 22 },
    },
    defaultTimeoutSec: 600,
  })),
}))

// Mock os
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
  hostname: () => 'test-host',
}))

describe('device-bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockStdin.write.mockReset()
    mockStdout.on.mockReset()
    mockStderr.on.mockReset()
    mockProcess.on.mockReset()
    mockProcess.kill.mockReset()
  })

  it('should load devices from pi-link config excluding self', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          self: { user: 'user', host: 'localhost', port: 22 },
          device1: { user: 'user', host: 'host1', port: 22 },
          device2: { user: 'user', host: 'host2', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    const status = bridge.getDeviceStatus()
    expect(status).toHaveLength(2)
    expect(status.map(s => s.name)).toContain('device1')
    expect(status.map(s => s.name)).toContain('device2')
    expect(status.map(s => s.name)).not.toContain('self')
  })

  it('should start SSH connection for each device', async () => {
    const { spawn } = await import('node:child_process')
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    await bridge.startAll()
    
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining([
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=10',
        '-p', '22',
        'user@host1',
        'pi', '--mode', 'rpc', '--no-extensions',
        '--session-dir', '~/.pi/agent/sessions/webui-bridge',
      ]),
      expect.any(Object)
    )
  })

  it('should send message to connected device', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    // Simulate connected state
    await bridge.startAll()
    // 推进定时器使 readyWindow 触发（connectTimeout=10s + 2s 缓冲 = 12s）
    await vi.advanceTimersByTimeAsync(12000)
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'test-host',
      senderDevice: 'test-host',
      content: 'Hello',
      target: 'device1',
      type: 'text' as const,
    }
    
    const sent = bridge.sendToDevice('device1', msg)
    expect(sent).toBe(true)
    expect(mockStdin.write).toHaveBeenCalled()
  })

  it('should return false when sending to disconnected device', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    // Don't start - device not connected
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'test-host',
      senderDevice: 'test-host',
      content: 'Hello',
      target: 'device1',
      type: 'text' as const,
    }
    
    const sent = bridge.sendToDevice('device1', msg)
    expect(sent).toBe(false)
  })

  it('should broadcast to all devices', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
          device2: { user: 'user', host: 'host2', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    await bridge.startAll()
    // 推进定时器使 readyWindow 触发（connectTimeout=10s + 2s 缓冲 = 12s）
    await vi.advanceTimersByTimeAsync(12000)
    
    const msg = {
      id: '1',
      ts: 1000,
      sender: 'test-host',
      senderDevice: 'test-host',
      content: 'Broadcast',
      target: null,
      type: 'text' as const,
    }
    
    bridge.broadcastToDevices(msg)
    
    expect(mockStdin.write).toHaveBeenCalledTimes(2)
  })

  it('should report device status', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
          device2: { user: 'user', host: 'host2', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    const status = bridge.getDeviceStatus()
    expect(status).toHaveLength(2)
    expect(status[0]).toHaveProperty('name')
    expect(status[0]).toHaveProperty('online')
  })

  it('should stop all connections', async () => {
    const { DeviceBridge } = await import('../device-bridge')
    
    const bridge = new DeviceBridge(
      {
        devices: {
          device1: { user: 'user', host: 'host1', port: 22 },
        },
        defaultTimeoutSec: 600,
      },
      'test-host'
    )
    
    await bridge.startAll()
    await bridge.stopAll()
    
    expect(mockProcess.kill).toHaveBeenCalled()
  })
})