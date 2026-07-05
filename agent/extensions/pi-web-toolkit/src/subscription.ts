import type { ParsedProxy } from './types'

function base64Decode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  try { return Buffer.from(s, 'base64').toString('utf-8') } catch { return '' }
}

function safeB64Url(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/')
}

function safeUnescape(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function parseQuery(q: string): Record<string, string> {
  const r: Record<string, string> = {}
  if (!q) return r
  for (const p of q.split('&')) {
    const i = p.indexOf('=')
    if (i > 0) r[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1))
  }
  return r
}

function buildTlsConfig(params: Record<string, string>, host: string): Record<string, unknown> | undefined {
  const sec = params.security || 'none'
  if (sec === 'none' || sec === '') return undefined
  const tls: Record<string, unknown> = { enabled: true }
  const sni = params.sni || params.host || host
  if (sni) tls.server_name = sni
  const alpn = params.alpn
  if (alpn) tls.alpn = alpn.split(',')
  return tls
}

function buildTlsConfigHy2(server: string): Record<string, unknown> | undefined {
  return { enabled: true, server_name: server }
}

function buildTransport(params: Record<string, string>): Record<string, unknown> | undefined {
  const net = params.type || 'tcp'
  if (net === 'tcp') return undefined
  const t: Record<string, unknown> = { type: net }
  if (net === 'ws') {
    const path = params.path || '/'
    t.path = path
    const host = params.host
    if (host) t.headers = { Host: host }
    const ed = +params.ed
    if (!isNaN(ed) && ed > 0) t.max_early_data = ed
  } else if (net === 'grpc') {
    t.service_name = params.serviceName || params.path || ''
  } else if (net === 'h2' || net === 'http') {
    t.host = params.host ? [params.host] : []
    t.path = params.path || '/'
  }
  return t
}

function parseVless(link: string, provider: string, index: number): ParsedProxy | null {
  try {
    const url = new URL(link)
    const [uuid, hostport] = url.username ? [url.username, url.host] : ['', url.host]
    const h = hostport.includes('@') ? hostport.split('@')[1] : hostport
    const host = h.split(':')[0]
    const port = parseInt(h.split(':')[1] || '443')
    const params = parseQuery(url.search.slice(1))
    const remark = safeUnescape(url.hash.slice(1)) || `vless-${index}`
    const tag = `${provider}-${String(index).padStart(2, '0')}`

    const outbound: Record<string, unknown> = {
      type: 'vless',
      tag,
      server: host,
      server_port: port,
      uuid,
      packet_encoding: 'xudp',
    }

    const flow = params.flow
    if (flow) outbound.flow = flow

    const tls = buildTlsConfig(params, host)
    if (tls) outbound.tls = tls
    const transport = buildTransport(params)
    if (transport) outbound.transport = transport

    return { tag, remark, provider, protocol: 'vless', outbound }
  } catch { return null }
}

function parseVmess(link: string, provider: string, index: number): ParsedProxy | null {
  try {
    const raw = link.slice(8)
    const json = JSON.parse(base64Decode(raw))
    const host = json.add || json.address || ''
    const port = parseInt(json.port || '443')
    const remark = json.ps || json.remarks || `vmess-${index}`
    const tag = `${provider}-${String(index).padStart(2, '0')}`

    const outbound: Record<string, unknown> = {
      type: 'vmess',
      tag,
      server: host,
      server_port: port,
      uuid: json.id,
      security: json.scy || 'auto',
    }

    const aid = parseInt(json.aid || '0')
    if (aid > 0) outbound.alter_id = aid

    if (json.tls && !json.security) json.security = json.tls
    const tls = buildTlsConfig(json, host)
    if (tls) outbound.tls = tls

    const net = json.net || json.network || 'tcp'
    const transport: Record<string, unknown> = {}
    if (net === 'ws') {
      transport.type = 'ws'
      if (json.path) transport.path = json.path
      if (json.host) transport.headers = { Host: json.host }
    } else if (net === 'grpc') {
      transport.type = 'grpc'
      transport.service_name = json.path || json.serviceName || ''
    } else if (net === 'h2' || net === 'http') {
      transport.type = net
      transport.host = json.host ? [json.host] : []
      transport.path = json.path || '/'
    } else if (net !== 'tcp') {
      transport.type = net
    }
    if (Object.keys(transport).length > 0) outbound.transport = transport

    return { tag, remark, provider, protocol: 'vmess', outbound }
  } catch { return null }
}

function parseTrojan(link: string, provider: string, index: number): ParsedProxy | null {
  try {
    const url = new URL(link)
    const password = url.username
    const host = url.hostname
    const port = parseInt(url.port || '443')
    const params = parseQuery(url.search.slice(1))
    const remark = safeUnescape(url.hash.slice(1)) || `trojan-${index}`
    const tag = `${provider}-${String(index).padStart(2, '0')}`

    const outbound: Record<string, unknown> = {
      type: 'trojan',
      tag,
      server: host,
      server_port: port,
      password,
    }

    const tls = buildTlsConfig(params, host)
    if (tls) outbound.tls = tls
    const transport = buildTransport(params)
    if (transport) outbound.transport = transport

    return { tag, remark, provider, protocol: 'trojan', outbound }
  } catch { return null }
}

function parseSs(link: string, provider: string, index: number): ParsedProxy | null {
  try {
    const q = link.indexOf('?')
    const cleanLink = q > 0 ? link.slice(0, q) : link
    const hashPos = cleanLink.indexOf('#')
    let b64part = '', hostport = '', remark = `ss-${index}`
    const payload = hashPos > 0 ? cleanLink.slice(5, hashPos) : cleanLink.slice(5)
    if (hashPos > 0) remark = safeUnescape(cleanLink.slice(hashPos + 1))
    if (payload.includes('@')) {
      [, hostport] = payload.split('@')
      b64part = payload.split('@')[0]
    } else {
      hostport = payload
    }
    if (!hostport) return null

    const host = hostport.split(':')[0]
    const port = parseInt(hostport.split(':')[1] || '443')
    const tag = `${provider}-${String(index).padStart(2, '0')}`

    let method = 'aes-256-gcm', password = ''
    if (b64part) {
      const decoded = base64Decode(safeB64Url(b64part))
      const ci = decoded.indexOf(':')
      if (ci > 0) { method = decoded.slice(0, ci); password = decoded.slice(ci + 1) }
    }

    const outbound: Record<string, unknown> = {
      type: 'shadowsocks',
      tag,
      server: host,
      server_port: port,
      method,
      password,
    }

    return { tag, remark, provider, protocol: 'shadowsocks', outbound }
  } catch { return null }
}

function parseHy2(link: string, provider: string, index: number): ParsedProxy | null {
  try {
    const raw = link.replace(/^hy2:\/\//, 'hysteria2://')
    const url = new URL(raw)
    const password = url.username
    const host = url.hostname
    const port = parseInt(url.port || '443')
    const params = parseQuery(url.search.slice(1))
    const remark = safeUnescape(url.hash.slice(1)) || `hy2-${index}`
    const tag = `${provider}-${String(index).padStart(2, '0')}`

    const outbound: Record<string, unknown> = {
      type: 'hysteria2',
      tag,
      server: host,
      server_port: port,
      password,
    }

    const tls = buildTlsConfig(params, host) || buildTlsConfigHy2(host)
    if (tls) outbound.tls = tls
    if (params.obfs) outbound.obfs = { type: params.obfs }
    if (params.obfs_password) {
      if (!outbound.obfs) outbound.obfs = {}
      ;(outbound.obfs as Record<string, unknown>).password = params.obfs_password
    }

    return { tag, remark, provider, protocol: 'hysteria2', outbound }
  } catch { return null }
}

function detectAndParse(link: string, provider: string, index: number): ParsedProxy | null {
  const scheme = link.split(':')[0]
  if (scheme === 'vless') return parseVless(link, provider, index)
  if (scheme === 'vmess') return parseVmess(link, provider, index)
  if (scheme === 'trojan') return parseTrojan(link, provider, index)
  if (scheme === 'ss') return parseSs(link, provider, index)
  if (scheme === 'hy2' || scheme === 'hysteria2') return parseHy2(link, provider, index)
  return null
}

function parseClashYaml(content: string): ParsedProxy[] {
  const result: ParsedProxy[] = []
  try {
    const lines = content.split('\n')
    let inProxies = false
    let depth = 0
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('proxies:')) { inProxies = true; depth = 0; continue }
      if (!inProxies) continue
      if (t.startsWith('proxy-groups:') || t.startsWith('rules:')) break
      if (t.startsWith('- name:')) {
        const name = t.match(/name:\s*"(.+?)"/)?.[1] || t.match(/name:\s*(.+)/)?.[1] || ''
        result.push({
          tag: `clash-${result.length}`,
          remark: name,
          provider: 'clash',
          protocol: 'unknown',
          outbound: { type: 'direct', tag: `clash-${result.length}`, server: name },
        })
      }
    }
  } catch { /* ignore */ }
  return result
}

export async function fetchSubscription(url: string, provider: string): Promise<ParsedProxy[]> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`)
  const text = await resp.text()
  return parseSubscriptionText(text, provider)
}

export function parseSubscriptionText(text: string, provider: string): ParsedProxy[] {
  const seen = new Set<string>()
  const result: ParsedProxy[] = []

  const isBase64 = /^[A-Za-z0-9+/=_-]+$/.test(text.trim()) && text.length > 50
  if (isBase64) {
    const decoded = base64Decode(text.trim())
    if (decoded) text = decoded
  }

  if (text.includes('proxies:') && text.includes('proxy-groups:')) {
    return parseClashYaml(text)
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l)
  for (const line of lines) {
    if (line.startsWith('ssr://')) continue
    if (seen.has(line)) continue
    seen.add(line)
    const parsed = detectAndParse(line, provider, result.length)
    if (parsed) result.push(parsed)
  }
  return result
}

const HTTP_PROXY_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/

export function parseHttpProxyList(text: string, provider: string): ParsedProxy[] {
  const result: ParsedProxy[] = []
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  for (const line of lines) {
    const m = line.match(HTTP_PROXY_RE)
    if (m) {
      const tag = `${provider}-${String(result.length).padStart(2, '0')}`
      result.push({
        tag,
        remark: `http-${m[1]}:${m[2]}`,
        provider,
        protocol: 'http',
        outbound: {
          type: 'http',
          tag,
          server: m[1],
          server_port: parseInt(m[2]),
        },
      })
    }
  }
  return result
}

export async function fetchAndMerge(urls: string[]): Promise<ParsedProxy[]> {
  const all: ParsedProxy[] = []
  const seenTags = new Set<string>()
  const seenRemarks = new Set<string>()

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const provider = `p${i}`
    try {
      let proxies: ParsedProxy[]
      if (url.startsWith('file://')) {
        const { readFileSync } = await import('fs')
        const content = readFileSync(url.replace('file://', ''), 'utf-8')
        proxies = parseHttpProxyList(content, provider)
      } else {
        proxies = await fetchSubscription(url, provider)
      }

      for (const p of proxies) {
        if (seenTags.has(p.tag)) continue
        if (p.remark && seenRemarks.has(p.remark)) { p.remark += `-${provider}` }
        seenTags.add(p.tag)
        seenRemarks.add(p.remark || p.tag)
        all.push(p)
      }
    } catch (e) {
      console.error(`[subscription] failed to fetch ${url}: ${(e as Error).message}`)
    }
  }

  return all
}
