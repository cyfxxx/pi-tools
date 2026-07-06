import { homedir } from 'os'
import { join } from 'path'
import type { ProxyPoolConfig } from './types'

const PI_CONFIG_DIR = '.pi'

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1))
  }
  return p
}

export function buildProxyPoolConfig(ext: Record<string, unknown>): Partial<{ proxy_pool: ProxyPoolConfig }> {
  const pp = ext.proxy_pool as Record<string, unknown> | undefined
  if (!pp) return {}

  const sbCfg = (pp.sing_box || pp.mihomo) as Record<string, unknown> | undefined
  const piDir = join(homedir(), PI_CONFIG_DIR)

  const sourceUrls = pp.subscription_urls
    ? pp.subscription_urls as string[]
    : pp.v2ray_source_urls
      ? pp.v2ray_source_urls as string[]
      : pp.proxy_source_urls
        ? pp.proxy_source_urls as string[]
        : undefined

  const pool: ProxyPoolConfig = {
    enabled: pp.enabled !== false,
    sing_box: {
      binary_path: expandHome((sbCfg?.binary_path || join(piDir, 'sing-box', 'sing-box')) as string),
      work_dir: expandHome((sbCfg?.work_dir || join(piDir, 'sing-box', 'run')) as string),
      mixed_port: (pp.local_proxy_port ?? sbCfg?.mixed_port ?? 19998) as number,
      external_controller_port: (sbCfg?.external_controller_port ?? 9090) as number,
      log_level: (sbCfg?.log_level || 'error') as string,
    },
    subscription_urls: sourceUrls || [],
    proxies: pp.proxies as string[] | undefined,
    strategy: (pp.strategy || 'round-robin') as 'random' | 'round-robin' | 'latency',
    health_check_url: (pp.health_check_url || 'http://httpbin.org/ip') as string,
    health_check_interval: (pp.health_check_interval ?? 300) as number,
    fallback_direct: pp.fallback_direct !== false,
  }

  return { proxy_pool: pool }
}
