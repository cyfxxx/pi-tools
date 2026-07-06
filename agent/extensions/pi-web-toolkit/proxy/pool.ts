import type { ProxyPoolConfig, PoolStats } from './types'
import { SingBoxManager } from './sing-box'

const PROXY_ENV_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const

export class ProxyPool {
  private sb: SingBoxManager
  private config: ProxyPoolConfig
  private _systemProxyEnabled = false

  constructor(config: ProxyPoolConfig) {
    this.config = config
    this.sb = new SingBoxManager()
  }

  async init(): Promise<void> {
    this.sb.setConfig({
      sing_box: this.config.sing_box,
      subscription_urls: this.config.subscription_urls,
      proxies: this.config.proxies,
      strategy: this.config.strategy || 'round-robin',
      health_check_url: this.config.health_check_url || 'http://httpbin.org/ip',
      health_check_interval: this.config.health_check_interval || 300,
      fallback_direct: this.config.fallback_direct !== false,
    })
    await this.sb.start()
  }

  getLocalProxyUrl(): string {
    return `http://127.0.0.1:${this.sb.getMixedPort()}`
  }

  async rotate(): Promise<string | null> {
    try {
      return await this.sb.rotate()
    } catch (e) {
      console.error(`[proxy-pool] rotate failed: ${(e as Error).message}`)
      return null
    }
  }

  async getStats(): Promise<PoolStats> {
    const sbStats = await this.sb.getStats()
    return {
      ...sbStats,
      systemProxyEnabled: this._systemProxyEnabled,
      systemProxyUrl: this._systemProxyEnabled ? this.getLocalProxyUrl() : null,
    }
  }

  async addProxies(urls: string[]): Promise<void> {
    await this.sb.addProxies(urls)
  }

  isRunning(): boolean {
    return this.sb.isRunning()
  }

  enableSystemProxy(): void {
    const proxyUrl = this.getLocalProxyUrl()
    process.env.HTTP_PROXY = proxyUrl
    process.env.HTTPS_PROXY = proxyUrl
    process.env.http_proxy = proxyUrl
    process.env.https_proxy = proxyUrl
    process.env.NO_PROXY = '127.0.0.1,localhost,.local'
    process.env.no_proxy = '127.0.0.1,localhost,.local'
    this._systemProxyEnabled = true
    console.error(`[proxy-pool] 系统代理已启用: ${proxyUrl}`)
  }

  disableSystemProxy(): void {
    for (const v of PROXY_ENV_VARS) {
      delete process.env[v]
    }
    this._systemProxyEnabled = false
    console.error('[proxy-pool] 系统代理已禁用')
  }

  isSystemProxyEnabled(): boolean {
    return this._systemProxyEnabled
  }

  stop(): void {
    this.disableSystemProxy()
    this.sb.stop()
  }
}
