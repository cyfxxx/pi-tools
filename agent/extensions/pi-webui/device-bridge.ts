/**
 * pi-webui — 设备间消息转发 (通过 pi-link SSH)
 *
 * 每台设备的 pi-webui server 启动一个 SSH 监听进程:
 *   ssh -o StrictHostKeyChecking=no <user>@<host> pi --mode rpc --no-extensions
 *
 * 收到消息时，通过 SSH 通道转发给目标设备的 pi-webui。
 * 使用 JSONL 协议: 每行一个 JSON 对象。
 *
 * 与 pi-link 的关系:
 * - 复用 pi-link.json 的设备清单 (不重复配置)
 * - 但使用独立的 SSH 会话 (避免与 pi-link 的 agent RPC 冲突)
 * - 转发层只做消息路由，不触发 pi agent 处理
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ChatMessage } from './types.ts'
import type { DeviceConfig } from '../../pi-link/config.ts'

interface LinkConfig {
  devices: Record<string, DeviceConfig>
  defaultTimeoutSec: number
  selfName?: string
}

interface BridgeDevice {
  name: string
  config: DeviceProcess
  process: ChildProcess | null
  connected: boolean
  lastError?: string
}

interface DeviceProcess {
  deviceConfig: DeviceConfig
  jsonlFile: string  // 用于写入消息的 FIFO/文件
}

const PI_LINK_CONFIG = join(homedir(), '.pi', 'pi-link.json')
const BRIDGE_STATE = join(homedir(), '.pi', 'webui', 'bridge-state.json')
const selfName = (): string => {
  try {
    const cfg = JSON.parse(readFileSync(PI_LINK_CONFIG, 'utf-8')) as LinkConfig
    return cfg.selfName ?? hostname()
  } catch {
    return hostname()
  }
}

function hostname(): string {
  try {
    const { hostname } = await import('node:os')
    return hostname()
  } catch {
    return 'unknown'
  }
}

export class DeviceBridge {
  private devices = new Map<string, BridgeDevice>()
  private onMessage?: (msg: ChatMessage) => void

  constructor(
    private linkConfig: LinkConfig,
    private selfDeviceName: string
  ) {
    // 加载设备清单，排除自己
    for (const [name, cfg] of Object.entries(linkConfig.devices)) {
      if (name === 'self' || name === selfDeviceName) continue
      this.devices.set(name, {
        name,
        config: {
          deviceConfig: cfg,
          jsonlFile: join(homedir(), '.pi', 'webui', 'bridge', `${name}.jsonl`),
        },
        process: null,
        connected: false,
      })
    }
  }

  /** 设置消息回调 (收到其他设备的消息时调用) */
  onRemoteMessage(callback: (msg: ChatMessage) => void): void {
    this.onMessage = callback
  }

  /** 启动所有设备的桥接连接 */
  async startAll(): Promise<void> {
    for (const [, device] of this.devices) {
      await this.startDevice(device)
    }
  }

  /** 停止所有连接 */
  async stopAll(): Promise<void> {
    for (const [, device] of this.devices) {
      this.stopDevice(device)
    }
  }

  /** 发送消息到指定设备 */
  sendToDevice(targetDevice: string, msg: ChatMessage): boolean {
    const device = this.devices.get(targetDevice)
    if (!device || !device.process || !device.connected) return false
    try {
      const envelope = JSON.stringify({
        type: 'webui_msg',
        payload: msg,
        ts: Date.now(),
        from: this.selfDeviceName,
      }) + '\n'
      device.process.stdin?.write(envelope)
      return true
    } catch {
      return false
    }
  }

  /** 广播消息到所有在线设备 */
  broadcastToDevices(msg: ChatMessage): void {
    for (const [name] of this.devices) {
      this.sendToDevice(name, msg)
    }
  }

  /** 获取设备在线状态 */
  getDeviceStatus(): Array<{ name: string; online: boolean; error?: string }> {
    const result: Array<{ name: string; online: boolean; error?: string }> = []
    for (const [name, device] of this.devices) {
      result.push({
        name,
        online: device.connected,
        error: device.lastError,
      })
    }
    return result
  }

  private async startDevice(device: BridgeDevice): Promise<void> {
    const cfg = device.config.deviceConfig
    const user = cfg.user
    const host = cfg.host
    const port = cfg.port ?? 22
    const timeout = cfg.timeoutSec ?? this.linkConfig.defaultTimeoutSec ?? 600

    // 使用 pi-link 相同的 RPC 模式，但用独立会话目录
    const rpcArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-p', String(port),
      `${user}@${host}`,
      'pi', '--mode', 'rpc', '--no-extensions',
      '--session-dir', `~/.pi/agent/sessions/webui-bridge`,
    ]

    // 追加 sshArgs
    if (cfg.sshArgs) rpcArgs.splice(0, 0, ...cfg.sshArgs)

    try {
      const proc = spawn('ssh', rpcArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 0,
      })

      device.process = proc
      device.connected = true
      device.lastError = undefined

      // 监听 stdout (JSONL 响应)
      let buffer = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.type === 'webui_msg' && data.payload) {
              this.onMessage?.(data.payload as ChatMessage)
            }
          } catch {
            // 非 JSON 行，忽略
          }
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          device.lastError = text.slice(0, 200)
        }
      })

      proc.on('close', (code) => {
        device.connected = false
        device.process = null
        device.lastError = `exit code ${code}`
        // 自动重连 (延迟 5s)
        setTimeout(() => {
          if (!device.connected) {
            this.startDevice(device).catch(() => {})
          }
        }, 5000)
      })

      proc.on('error', (err) => {
        device.connected = false
        device.lastError = err.message.slice(0, 200)
      })

      console.log(`[pi-webui] 桥接已连接: ${device.name} (${user}@${host}:${port})`)
    } catch (err) {
      device.connected = false
      device.lastError = (err as Error).message.slice(0, 200)
      console.warn(`[pi-webui] 桥接连接失败: ${device.name} — ${device.lastError}`)
    }
  }

  private stopDevice(device: BridgeDevice): void {
    if (device.process) {
      device.process.kill('SIGTERM')
      device.process = null
      device.connected = false
    }
  }
}

/** 加载 pi-link 配置 */
export function loadLinkConfig(): LinkConfig {
  if (!existsSync(PI_LINK_CONFIG)) {
    return { devices: {}, defaultTimeoutSec: 600 }
  }
  try {
    return JSON.parse(readFileSync(PI_LINK_CONFIG, 'utf-8')) as LinkConfig
  } catch {
    return { devices: {}, defaultTimeoutSec: 600 }
  }
}
