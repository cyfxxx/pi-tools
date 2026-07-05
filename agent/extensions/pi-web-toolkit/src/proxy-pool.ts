import type { ProxyPoolConfig, PoolStats } from './types'
import { SingBoxManager } from './sing-box-manager'

export class ProxyPool {
  private sb: SingBoxManager
  private config: ProxyPoolConfig

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
    return this.sb.getStats()
  }

  async addProxies(urls: string[]): Promise<void> {
    await this.sb.addProxies(urls)
  }

  stop(): void {
    this.sb.stop()
  }
}
