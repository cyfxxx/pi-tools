export interface SearchConfig {
  searxng_url: string
  timeout: number
}

export interface BrowserConfig {
  headless: boolean
  viewport_width: number
  viewport_height: number
  fingerprint_seed?: string
  proxy?: string
  data_dir?: string
}

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

export interface WebToolkitConfig {
  search: SearchConfig
  browser: BrowserConfig
  proxy_pool?: ProxyPoolConfig
}

export interface SearchResultItem {
  title: string
  url: string
  content?: string
  engine?: string
  score?: number
  category?: string
  publishedDate?: string
  thumbnail?: string
}

export interface SearchResponse {
  query: string
  number_of_results: number
  results: SearchResultItem[]
  answers: string[]
  corrections: string[]
  suggestions: string[]
  unresponsive_engines: string[]
  infoboxes: Array<{ title?: string; content?: string; [key: string]: unknown }>
}

export interface PageInfo {
  url: string
  title: string
  content: string
  textContent: string
  viewport: { width: number; height: number }
}

export interface ParsedProxy {
  tag: string
  remark: string
  provider: string
  protocol: string
  outbound: Record<string, unknown>
}
