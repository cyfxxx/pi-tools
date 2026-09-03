/**
 * pi-webui — HTTP 服务器
 *
 * 提供:
 * - 静态文件服务 (前端构建产物)
 * - REST API (消息历史、设备列表、配置)
 * - WebSocket 升级 (实时聊天)
 *
 * 安全: 简单 token 认证 (config.authToken)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ChatMessage, WebuiConfig, WsEnvelope } from './types.ts'
import type { WsHub } from './ws-hub.ts'
import { getMessages, appendMessage } from './message-store.ts'
import { chatIdForGroup, chatIdForPrivate } from './types.ts'
import { nanoid } from './nanoid.ts'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

export interface ServerContext {
  config: WebuiConfig
  hub: WsHub
  staticDir: string
  selfDevice: string
  /** 外部提供的消息处理回调 */
  onUserMessage?: (msg: ChatMessage) => void
}

function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): boolean {
  let urlPath = req.url?.split('?')[0] ?? '/'
  if (urlPath === '/') urlPath = '/index.html'

  const filePath = join(staticDir, urlPath)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: 所有非文件请求返回 index.html
    const indexPath = join(staticDir, 'index.html')
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(content)
      return true
    }
    return false
  }

  const ext = extname(filePath)
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': mime })
  res.end(content)
  return true
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function checkAuth(req: IncomingMessage, config: WebuiConfig): boolean {
  if (!config.authToken) return true
  const auth = req.headers.authorization
  if (auth === `Bearer ${config.authToken}`) return true
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  return url.searchParams.get('token') === config.authToken
}

export function createWebuiServer(
  ctx: ServerContext,
  onWsConnect?: (ws: WebSocket, device: string, isUser: boolean) => void
): { server: ReturnType<typeof createServer>; wss: WebSocketServer } {
  const { config, hub, staticDir, selfDevice } = ctx

  const server = createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    // 认证：仅对 /api/* 生效；静态资源与首页放行（首页由 JS 侧自行携带 token 请求 API）
    if (url.pathname.startsWith('/api/') && !checkAuth(req, config)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    // API 路由
    if (url.pathname === '/api/messages') {
      const chatId = url.searchParams.get('chatId') ?? 'group'
      const before = url.searchParams.get('before')
      const limit = url.searchParams.get('limit')
      const messages = getMessages(chatId, {
        before: before ? Number(before) : undefined,
        limit: limit ? Number(limit) : undefined,
      })
      sendJson(res, 200, { messages })
      return
    }

    if (url.pathname === '/api/devices') {
      const statuses = hub.getAllDeviceStatus()
      sendJson(res, 200, { devices: statuses, self: selfDevice })
      return
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body) as {
            target: string | null
            content: string
            type?: string
          }
          const msg: ChatMessage = {
            id: nanoid(),
            ts: Date.now(),
            sender: 'user',
            senderDevice: selfDevice,
            target: data.target ?? null,
            type: (data.type as ChatMessage['type']) ?? 'text',
            content: data.content,
          }
          appendMessage(msg)
          ctx.onUserMessage?.(msg)
          sendJson(res, 200, { ok: true, message: msg })
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message })
        }
      })
      return
    }

    if (url.pathname === '/api/config') {
      sendJson(res, 200, {
        port: config.port,
        host: config.host,
        selfDevice,
        enableFileUpload: config.enableFileUpload,
      })
      return
    }

    // 静态文件
    if (!serveStatic(req, res, staticDir)) {
      sendJson(res, 404, { error: 'not found' })
    }
  })

  // WebSocket
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws, req) => {
    // 从 query 参数获取设备名和身份
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const device = url.searchParams.get('device') ?? selfDevice
    const isUser = url.searchParams.get('user') === '1'
    const token = url.searchParams.get('token')

    // WebSocket 认证
    if (config.authToken && token !== config.authToken) {
      ws.close(4001, 'unauthorized')
      return
    }

    hub.register(ws, device, isUser)
    onWsConnect?.(ws, device, isUser)

    // 发送设备列表
    const devices = hub.getAllDeviceStatus()
    const envelope: WsEnvelope = {
      type: 'device_list',
      payload: devices,
      ts: Date.now(),
    }
    ws.send(JSON.stringify(envelope))

    ws.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString()) as WsEnvelope
        handleWsMessage(ws, envelope, ctx, device)
      } catch {
        // 忽略非法消息
      }
    })
  })

  return { server, wss }
}

function handleWsMessage(
  ws: WebSocket,
  envelope: WsEnvelope,
  ctx: ServerContext,
  sourceDevice: string
): void {
  switch (envelope.type) {
    case 'chat': {
      const msg = envelope.payload as ChatMessage
      // 补充来源信息
      msg.senderDevice = sourceDevice
      if (!msg.id) msg.id = nanoid()
      if (!msg.ts) msg.ts = Date.now()

      // 存储消息
      appendMessage(msg)

      // 广播
      if (msg.target === null) {
        ctx.hub.broadcast(msg)
      } else {
        ctx.hub.sendToDevice(msg.target, msg)
        // 也发给发送者自己的其他客户端
        ctx.hub.sendToDevice(sourceDevice, msg)
      }

      // 通知外部 (pi agent 钩子)
      ctx.onUserMessage?.(msg)
      break
    }
    case 'typing': {
      const payload = envelope.payload as { chatId: string; user?: string }
      ctx.hub.sendTyping(payload.chatId, payload.user ?? sourceDevice, sourceDevice)
      break
    }
    case 'sync_request': {
      const payload = envelope.payload as { chatId: string; before?: number; limit?: number }
      const messages = getMessages(payload.chatId, {
        before: payload.before,
        limit: payload.limit,
      })
      const response: WsEnvelope = {
        type: 'sync_response',
        payload: { chatId: payload.chatId, messages, hasMore: messages.length === (payload.limit ?? 50) },
        ts: Date.now(),
      }
      ws.send(JSON.stringify(response))
      break
    }
  }
}
