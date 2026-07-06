import type { SearchConfig } from './search/types'
import type { BrowserConfig } from './browser/types'
import type { ProxyPoolConfig } from './proxy/types'

export interface WebToolkitConfig {
  search: SearchConfig
  browser: BrowserConfig
  proxy_pool?: ProxyPoolConfig
}
