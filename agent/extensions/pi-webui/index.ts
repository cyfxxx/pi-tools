/**
 * pi-webui 扩展入口
 *
 * 替代 ntfy-relay，提供 WebUI 聊天界面:
 * - 每台设备运行独立的 HTTP + WebSocket 服务
 * - 复用 pi-link 设备清单做设备间通信
 * - 支持群聊 (所有设备 + 用户) 和私聊 (用户↔设备)
 *
 * 启动流程:
 * 1. 加载配置
 * 2. 启动 HTTP 服务 (静态文件 + API)
 * 3. 启动 WebSocket Hub
 * 4. 启动设备桥接 (pi-link SSH)
 * 5. 注册 pi agent 事件钩子
 *
 * 用法:
 *   /webui              显示状态 + 访问地址
 *   /webui start        启动服务
 *   /webui stop         停止服务
 *   /webui status       设备在线状态
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ChatMessage, WebuiConfig } from './types.ts'
import { DEFAULT_CONFIG } from './types.ts'
import { WsHub } from './ws-hub.ts'
import { DeviceBridge, loadLinkConfig } from './device-bridge.ts'
import { appendMessage, setMaxHistory } from './message-store.ts'
import { extractFinalReply, isTrivialReply, createAgentReplyMessage, WebuiTurnGate } from './pi-agent-hook.ts'
import { createWebuiServer, mergeDeviceStatuses, type ServerContext } from './server.ts'
import { nanoid } from './nanoid.ts'

const CONFIG_PATH = join(homedir(), '.pi', 'webui', 'config.json')
const SELF_NAME_FILE = join(homedir(), '.pi', 'webui', 'self-name')

function loadConfig(): WebuiConfig {
  const cfg = { ...DEFAULT_CONFIG }
  if (!existsSync(CONFIG_PATH)) {
    // 自动生成 authToken
    if (!cfg.authToken) {
      cfg.authToken = nanoid(32)
      saveConfig(cfg)
    }
    return cfg
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<WebuiConfig>
    if (typeof raw.port === 'number') cfg.port = raw.port
    if (typeof raw.host === 'string') cfg.host = raw.host
    if (typeof raw.authToken === 'string') cfg.authToken = raw.authToken
    if (typeof raw.maxMessageHistory === 'number') cfg.maxMessageHistory = raw.maxMessageHistory
    if (typeof raw.enableFileUpload === 'boolean') cfg.enableFileUpload = raw.enableFileUpload
    if (typeof raw.uploadDir === 'string') cfg.uploadDir = raw.uploadDir
  } catch {}
  // 自动生成 authToken
  if (!cfg.authToken) {
    cfg.authToken = nanoid(32)
    saveConfig(cfg)
  }
  return cfg
}

function saveConfig(cfg: WebuiConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
    renameSync(tmp, CONFIG_PATH)
  } catch {}
}

function getSelfName(): string {
  if (existsSync(SELF_NAME_FILE)) {
    try {
      return readFileSync(SELF_NAME_FILE, 'utf-8').trim()
    } catch {}
  }
  return process.env.PI_LINK_SELF_NAME ?? 'localhost'
}

function getStaticDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), 'static')
}

export default function piWebuiExtension(pi: ExtensionAPI): void {
  // Check if we should run in server mode or client mode
  // PI_WEBSUI_SERVER_MODE=false means we are in a subagent and should not start the server
  const isServerMode = process.env.PI_WEBSUI_SERVER_MODE !== 'false';

  if (!isServerMode) {
    // Client mode: register command as no-op in subagent context
    pi.registerCommand('webui', {
      description: 'WebUI 客户端模式（不启动服务）',
      handler: async () => {
        pi.sendMessage({ customType: 'webui-status', content: '当前为客户端模式，无法启动服务', display: false })
      },
    });
    // Return early - don't create hub, bridge, gate, or register message handlers
    return;
  }

  let config = loadConfig()
  setMaxHistory(config.maxMessageHistory)

  const selfDevice = getSelfName()
  const hub = new WsHub()
  const linkConfig = loadLinkConfig()
  const bridge = new DeviceBridge(linkConfig, selfDevice)

  // 回复门控：登记 webui 注入的消息，agent_end 只外发能与之配对的 run（本地对话不外发）
  const gate = new WebuiTurnGate()

  let serverCtx: ServerContext | null = null
  let httpServer: ReturnType<typeof import('node:http').createServer> | null = null
  let wss: import('ws').WebSocketServer | null = null

  // ── 消息路由 ──────────────────────────────────────
  function handleUserMessage(msg: ChatMessage): void {
    if (msg.target === null) {
      // 群聊: 广播 + 送本地 agent（带来源标签）
      bridge.broadcastToDevices(msg)
      const injected = `[群聊] ${msg.content}`
      gate.mark(injected, 'group')
      pi.sendUserMessage(injected, { deliverAs: 'followUp' })
    } else if (msg.target !== 'user' && msg.target !== selfDevice) {
      // 私聊 → 远程设备: 定向转发
      bridge.sendToDevice(msg.target, msg)
    } else if (msg.target === selfDevice) {
      // 私聊 → 本机: 送本地 agent（带来源标签）
      const injected = `[来自 ${msg.sender ?? 'user'} 的私聊] ${msg.content}`
      gate.mark(injected, 'private')
      pi.sendUserMessage(injected, { deliverAs: 'followUp' })
    }
  }

  function handleRemoteMessage(msg: ChatMessage): void {
    // 其他设备发来的消息
    appendMessage(msg)
    if (msg.target === null) {
      // 群聊: 广播给本地客户端
      hub.broadcast(msg)
    } else {
      // 私聊: 发给目标客户端
      hub.sendToDevice(msg.target, msg)
      hub.sendToDevice(selfDevice, msg)
    }
  }

  bridge.onRemoteMessage(handleRemoteMessage)

  // ── pi agent 钩子 ─────────────────────────────────

  // agent_end: 仅当本次 run 由 webui 消息触发时才外发回复（gate 配对注入文本与本次 run）。
  // 本地 TUI / 其他扩展触发的对话一律不发，避免 agent 工作输出污染聊天记录、回复落错会话。
  // 归属（群聊/私聊）由命中的登记条目决定，不读“最近一次 target”，避开 followUp 排队竞态。
  pi.on('agent_end', (event: { messages?: unknown[] }) => {
    let origin = gate.claim(event.messages ?? [])
    // 兜底：claim 未命中（如 run messages 不含注入文本），但有登记且本次 run 无新 user 消息
    // → 将回复归属到最早的登记，避免回复丢失（比不外发更安全，用户能看到回复）
    if (!origin && gate.size > 0 && !(event.messages ?? []).some(m => (m as {role?: string}).role === 'user')) {
      origin = gate.shift()
    }
    if (!origin) return
    const reply = extractFinalReply(event.messages ?? [])
    if (!reply || isTrivialReply(reply)) return

    const isPrivate = origin === 'private'
    const msg = createAgentReplyMessage(reply, selfDevice, isPrivate ? 'user' : null)
    appendMessage(msg)
    if (isPrivate) {
      // 私聊：发给用户客户端（前端按 senderDevice 过滤到对应私聊会话）；不转发给其他设备
      hub.sendToDevice('user', msg)
    } else {
      hub.broadcast(msg)
      bridge.broadcastToDevices(msg)
    }
  })

  // ── 斜杠命令 ──────────────────────────────────────

  pi.registerCommand('webui', {
    description: 'WebUI 聊天界面管理（/webui help 查看用法）',
    getArgumentCompletions: (prefix) => {
      const p = prefix?.trim() ?? ''
      const first = (p.split(/\s+/)[0] ?? '').toLowerCase()
      const items = [
        { value: 'start', label: 'start', description: '启动 WebUI 服务' },
        { value: 'stop', label: 'stop', description: '停止 WebUI 服务' },
        { value: 'status', label: 'status', description: '查看服务状态与设备' },
        { value: 'help', label: 'help', description: '显示用法' },
      ]
      if (!p.includes(' ')) {
        return items.filter(i => i.value.startsWith(first))
      }
      return []
    },
    async handler(args, ctx) {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || ''

      if (sub === 'start') {
        if (httpServer) {
          ctx.ui.notify('WebUI 服务已在运行', 'info')
          return
        }
        startServer(ctx)
        return
      }

      if (sub === 'stop') {
        if (!httpServer) {
          ctx.ui.notify('WebUI 服务未运行', 'info')
          return
        }
        await stopServer()
        ctx.ui.notify('WebUI 服务已停止', 'info')
        return
      }

      if (sub === 'status') {
        // 与 /api/devices、WS device_list 共用同一合并逻辑，避免 CLI 与网页不一致
        const devices = mergeDeviceStatuses(hub, bridge, selfDevice)
        const lines = [
          `WebUI: ${httpServer ? '运行中' : '未启动'}`,
          `地址: http://${config.host}:${config.port}`,
          `Token: ${config.authToken.slice(0, 8)}...`,
          '',
          '设备状态:',
          ...devices.map(d => {
            const tags: string[] = []
            if (d.wsConnected) tags.push('WS已连接')
            if (d.sshConnected) tags.push('SSH已连接')
            if (d.error) tags.push(d.error)
            return `  ${d.name}${d.name === selfDevice ? ' (本机)' : ''} ${d.online ? '● 在线' : '○ 离线'}${tags.length ? ` (${tags.join(', ')})` : ''}`
          }),
        ]
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      // 默认: 显示状态 + 访问地址
      const lanIP = detectLanIP()
      const lines = [
        `WebUI: ${httpServer ? '运行中' : '未启动'}`,
        `访问: http://${lanIP ?? 'localhost'}:${config.port}`,
        `Token: ${config.authToken}`,
        '',
        '命令:',
        '  /webui start  启动服务',
        '  /webui stop   停止服务',
        '  /webui status 设备状态',
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })

  async function startServer(ctx?: any): Promise<void> {
    if (httpServer) return

    config = loadConfig()
    setMaxHistory(config.maxMessageHistory)

    const staticDir = getStaticDir()

    serverCtx = {
      config,
      hub,
      staticDir,
      selfDevice,
      bridge,
      onUserMessage: handleUserMessage,
    }

    const result = createWebuiServer(serverCtx)
    httpServer = result.server
    wss = result.wss

    httpServer.listen(config.port, config.host, async () => {
      // 启动设备桥接
      await bridge.startAll()

      const lanIP = detectLanIP()
      const msg = `WebUI 已启动\n地址: http://${lanIP ?? 'localhost'}:${config.port}\nToken: ${config.authToken}`
      pi.sendMessage({ customType: 'webui-status', content: msg, display: false })
    })

    httpServer.on('error', (err) => {
      console.error(`[pi-webui] 启动失败:`, err.message)
      httpServer = null
      pi.sendMessage({
        customType: 'webui-status',
        content: `WebUI 启动失败: ${err.message}`,
        display: false,
      })
    })
  }

  async function stopServer(): Promise<void> {
    await bridge.stopAll()
    if (wss) {
      // 关闭所有 WebSocket 连接
      wss.clients.forEach(ws => {
        ws.close(1000, 'server shutdown')
      })
      wss.close()
      wss = null
    }
    if (httpServer) {
      httpServer.close()
      httpServer = null
    }
  }

  // ── 自动启动 ──────────────────────────────────────
  // 如果配置了 autoStart，则在 session_start 时自动启动
  pi.on('session_start', async () => {
    gate.reset()
    if (existsSync(CONFIG_PATH)) {
      const cfg = loadConfig()
      if (cfg.port > 0) {
        // 延迟启动，避免阻塞其他扩展初始化
        setTimeout(() => startServer(), 2000)
      }
    }
  })

  pi.on('session_shutdown', async () => {
    await stopServer()
  })
}

/** 探测局域网 IP */
function detectLanIP(): string | undefined {
  try {
    const os = require('node:os') as typeof import('node:os')
    const interfaces = os.networkInterfaces()
    for (const [, addrs] of Object.entries(interfaces)) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          return a.address
        }
      }
    }
  } catch {}
  return undefined
}
