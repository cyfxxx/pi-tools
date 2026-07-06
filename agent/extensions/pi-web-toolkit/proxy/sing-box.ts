import { spawn, ChildProcess } from 'child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { SingBoxConfig, ClashProxiesResponse, ClashProxyGroup, PoolStats, ParsedProxy } from './types'
import { fetchAndMerge, parseHttpProxyList } from './subscription'

export class SingBoxManager {
  private process: ChildProcess | null = null
  private config: SingBoxConfig
  private subscriptionUrls: string[] = []
  private staticProxies: string[] = []
  private strategy: string = 'round-robin'
  private healthCheckUrl: string = 'http://httpbin.org/ip'
  private healthCheckInterval: number = 300
  private fallbackDirect: boolean = true
  private allProxyNames: string[] = []
  private currentIndex: number = 0
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.config = {
      binary_path: '',
      work_dir: '',
      mixed_port: 19998,
      external_controller_port: 9090,
      log_level: 'error',
    }
  }

  setConfig(opts: {
    sing_box: SingBoxConfig
    subscription_urls: string[]
    proxies?: string[]
    strategy: string
    health_check_url: string
    health_check_interval: number
    fallback_direct: boolean
  }): void {
    this.config = { ...opts.sing_box }
    this.subscriptionUrls = opts.subscription_urls || []
    this.staticProxies = opts.proxies || []
    this.strategy = opts.strategy || 'round-robin'
    this.healthCheckUrl = opts.health_check_url || 'http://httpbin.org/ip'
    this.healthCheckInterval = opts.health_check_interval || 300
    this.fallbackDirect = opts.fallback_direct !== false
  }

  async start(): Promise<void> {
    if (this.process) return
    if (!existsSync(this.config.work_dir)) {
      mkdirSync(this.config.work_dir, { recursive: true })
    }

    await this.generateAndWriteConfig()
    await this.startProcess()
    await this.waitForReady()
    await this.syncProxyNames()
    this.startAutoRefresh()
  }

  stop(): void {
    this.stopAutoRefresh()
    if (this.process) {
      const proc = this.process
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }, 5000)
      proc.once('exit', () => clearTimeout(timer))
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      this.process = null
    }
  }

  isRunning(): boolean {
    if (!this.process) return false
    try { return this.process.exitCode === null } catch { return false }
  }

  getMixedPort(): number {
    return this.config.mixed_port
  }

  getApiUrl(): string {
    return `http://127.0.0.1:${this.config.external_controller_port}`
  }

  async rotate(): Promise<string> {
    const group = await this.getGroup('proxy-pool')
    if (!group || !group.all || group.all.length === 0) return 'no-proxy'
    this.currentIndex = Math.max(0, group.all.indexOf(group.now))
    this.currentIndex = (this.currentIndex + 1) % group.all.length
    const next = group.all[this.currentIndex]
    try {
      await this.selectProxy(next)
    } catch (e) {
      console.error(`[sing-box] rotate failed for ${next}: ${(e as Error).message}`)
    }
    return next
  }

  async selectProxy(name: string): Promise<void> {
    await this.api('PUT', `/proxies/proxy-pool`, { name })
  }

  async getNow(): Promise<string> {
    try {
      const group = await this.getGroup('proxy-pool')
      return group?.now || 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async getStats(): Promise<PoolStats> {
    const proxiesRes: ClashProxiesResponse = await this.api('GET', '/proxies')
    const group = proxiesRes?.proxies?.['proxy-pool']
    const all = group?.all || []
    const now = group?.now || ''
    const entries = all.map(name => {
      const p = proxiesRes?.proxies?.[name]
      const alive = p?.alive ?? true
      const history = p?.history ?? []
      const latency = history.length > 0 ? history[history.length - 1].delay : 0
      return {
        url: name,
        alive,
        latency,
        failures: 0,
        isCurrent: name === now,
      }
    })
    const alive = entries.filter(e => e.alive)
    const latencies = alive.map(e => e.latency).filter(l => l > 0)
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0
    return {
      total: entries.length,
      alive: alive.length,
      dead: entries.length - alive.length,
      avgLatency,
      strategy: this.strategy,
      current: now,
      systemProxyEnabled: false,
      systemProxyUrl: null,
      entries,
    }
  }

  async testDelay(targets?: string[]): Promise<Record<string, number>> {
    const items = targets || this.allProxyNames
    const results = await Promise.allSettled(
      items.map(async (name) => {
        const data = await this.api('GET', `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(this.healthCheckUrl)}&timeout=5000`)
        return { name, delay: data[name] as number }
      })
    )
    const result: Record<string, number> = {}
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && typeof r.value.delay === 'number') {
        result[r.value.name] = r.value.delay
      }
    }
    return result
  }

  async addProxies(urls: string[]): Promise<void> {
    this.staticProxies.push(...urls)
    await this.generateAndWriteConfig()
    await this.restart()
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  async refreshSubscriptions(): Promise<void> {
    try {
      await this.generateAndWriteConfig()
      if (this.isRunning()) {
        this.restart()
      }
    } catch (e) {
      console.error(`[sing-box] refresh error: ${(e as Error).message}`)
    }
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh()
    this.refreshTimer = setInterval(() => {
      this.refreshSubscriptions()
    }, this.healthCheckInterval * 1000)
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.getApiUrl()}${path}`
    const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) }
    if (body && (method === 'PUT' || method === 'POST')) {
      opts.body = JSON.stringify(body)
    }
    const res = await fetch(url, opts)
    if (!res.ok) throw new Error(`sing-box API ${method} ${path}: ${res.status}`)
    if (res.status === 204) return null
    return res.json()
  }

  private async getGroup(groupName: string): Promise<ClashProxyGroup | null> {
    const data: ClashProxiesResponse = await this.api('GET', '/proxies')
    const entry = data?.proxies?.[groupName]
    if (!entry || !entry.all) return null
    return {
      name: entry.name || groupName,
      type: entry.type,
      now: entry.now || entry.all[0] || '',
      all: entry.all,
    }
  }

  private async generateAndWriteConfig(): Promise<void> {
    const parsed = await fetchAndMerge(this.subscriptionUrls)
    const staticParsed: ParsedProxy[] = []

    for (const url of this.staticProxies) {
      try {
        const parsed = new URL(url)
        const host = parsed.hostname
        const port = parseInt(parsed.port || '80')
        const protocol = parsed.protocol.replace(':', '')
        if (protocol !== 'http' && protocol !== 'socks5' && protocol !== 'https') {
          console.error(`[sing-box] unsupported proxy protocol: ${protocol} in ${url}`)
          continue
        }
        staticParsed.push({
          tag: `static-${staticParsed.length}`,
          remark: `${protocol}-${host}:${port}`,
          provider: 'static',
          protocol,
          outbound: {
            type: protocol === 'socks5' ? 'socks' : protocol,
            tag: `static-${staticParsed.length}`,
            server: host,
            server_port: port,
          },
        })
      } catch {
        console.error(`[sing-box] invalid static proxy URL: ${url}`)
      }
    }

    const allParsed = [...parsed, ...staticParsed]

    const outboundTags: string[] = this.fallbackDirect ? ['direct'] : []
    const outbounds: Record<string, unknown>[] = []

    if (this.fallbackDirect) {
      outbounds.push({ type: 'direct', tag: 'direct' })
    }
    outbounds.push({ type: 'block', tag: 'block' })

    for (const p of allParsed) {
      outbounds.push(p.outbound)
      outboundTags.push(p.tag)
    }

    outbounds.push({
      type: 'selector',
      tag: 'proxy-pool',
      outbounds: outboundTags,
      default: this.fallbackDirect ? 'direct' : outboundTags[0] || 'direct',
    })

    const config = {
      log: { level: this.config.log_level },
      inbounds: [{
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: this.config.mixed_port,
      }],
      outbounds,
      route: {
        rules: [{ ip_is_private: true, outbound: 'direct' }],
        final: 'proxy-pool',
        auto_detect_interface: true,
      },
      experimental: {
        clash_api: {
          external_controller: `127.0.0.1:${this.config.external_controller_port}`,
          access_control_allow_origin: ['http://127.0.0.1'],
        },
      },
    }

    const configPath = join(this.config.work_dir, 'config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  private async startProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const bin = this.config.binary_path
      if (!existsSync(bin)) {
        reject(new Error(`sing-box binary not found: ${bin}`))
        return
      }

      const proc = spawn(bin, ['run', '-c', join(this.config.work_dir, 'config.json'), '-D', this.config.work_dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      proc.stdout?.on('data', () => { /* swallow */ })
      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString()
        if (msg.includes('error') || msg.includes('panic')) {
          console.error('[sing-box]', msg.trim())
        }
      })

      proc.on('error', (err: Error) => {
        reject(new Error(`Failed to start sing-box: ${err.message}`))
      })

      proc.on('exit', (code: number | null) => {
        if (code !== 0 && this.process === proc) {
          console.error(`[sing-box] exited with code ${code}`)
        }
        if (this.process === proc) this.process = null
      })

      this.process = proc
      resolve()
    })
  }

  private async waitForReady(): Promise<void> {
    const maxRetries = 30
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.api('GET', '/version')
        return
      } catch {
        await new Promise(r => setTimeout(r, 500))
      }
    }
    throw new Error('sing-box failed to start within timeout')
  }

  private async syncProxyNames(): Promise<void> {
    try {
      const group = await this.getGroup('proxy-pool')
      this.allProxyNames = group?.all || []
    } catch { /* ignore */ }
  }
}
