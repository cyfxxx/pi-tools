/**
 * pi-webui API 客户端
 */

import type { ChatMessage, AppConfig, DeviceStatus } from './types'

const BASE = '' // 相对路径，同源

export async function fetchConfig(token?: string): Promise<AppConfig> {
  const url = new URL(`${BASE}/api/config`, location.origin)
  if (token) url.searchParams.set('token', token)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchMessages(chatId: string, opts?: { before?: number; limit?: number }): Promise<ChatMessage[]> {
  const params = new URLSearchParams({ chatId })
  if (opts?.before) params.set('before', String(opts.before))
  if (opts?.limit) params.set('limit', String(opts.limit))
  const res = await fetch(`${BASE}/api/messages?${params}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.messages ?? []
}

export async function fetchDevices(): Promise<{ devices: DeviceStatus[]; self: string }> {
  const res = await fetch(`${BASE}/api/devices`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function sendMessage(target: string | null, content: string, type: string = 'text'): Promise<{ ok: boolean; message?: ChatMessage }> {
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, content, type }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
