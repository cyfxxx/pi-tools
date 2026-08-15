import type { SearchConfig } from './types'

export function buildSearchConfig(ext: Record<string, unknown>): Partial<{ search: SearchConfig }> {
  const r: Partial<{ search: SearchConfig }> = {}
  const s: { searxng_url?: string; timeout?: number } = {}
  if (ext.searxng_url != null) s.searxng_url = String(ext.searxng_url)
  if (ext.search_timeout != null) {
    // 审计 LOW：config 路径此前无 NaN 校验（env 路径有）——配置写非数字时
    // setTimeout(NaN)≈0ms 每次搜索都报超时
    const v = Number(ext.search_timeout)
    if (!Number.isNaN(v)) s.timeout = v
  }
  if (Object.keys(s).length > 0) r.search = s as SearchConfig
  return r
}

export function buildEnvSearchConfig(): Partial<{ search: SearchConfig }> {
  const s: { searxng_url?: string; timeout?: number } = {}
  if (process.env.PI_WEB_TOOLKIT_SEARXNG_URL) {
    s.searxng_url = process.env.PI_WEB_TOOLKIT_SEARXNG_URL
  }
  if (process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT) {
    const v = parseInt(process.env.PI_WEB_TOOLKIT_SEARCH_TIMEOUT)
    if (!Number.isNaN(v)) s.timeout = v
  }
  if (Object.keys(s).length > 0) return { search: s as SearchConfig }
  return {}
}
