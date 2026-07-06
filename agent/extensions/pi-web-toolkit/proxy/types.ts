export interface SingBoxConfig {
  binary_path: string
  work_dir: string
  mixed_port: number
  external_controller_port: number
  log_level: string
}

export interface ProxyPoolConfig {
  enabled: boolean
  sing_box: SingBoxConfig
  subscription_urls: string[]
  proxies?: string[]
  strategy: 'random' | 'round-robin' | 'latency'
  health_check_url: string
  health_check_interval: number
  fallback_direct: boolean
}

export interface PoolStats {
  total: number
  alive: number
  dead: number
  avgLatency: number
  strategy: string
  current: string
  systemProxyEnabled: boolean
  systemProxyUrl: string | null
  entries: Array<{
    url: string
    alive: boolean
    latency: number
    failures: number
    isCurrent?: boolean
  }>
}

export interface ClashProxyGroup {
  name: string
  type: string
  now: string
  all: string[]
}

export interface ClashProxiesResponse {
  proxies: Record<string, {
    name?: string
    type: string
    now?: string
    all?: string[]
    alive?: boolean
    history?: Array<{ delay: number }>
  }>
}

export interface ParsedProxy {
  tag: string
  remark: string
  provider: string
  protocol: string
  outbound: Record<string, unknown>
}
