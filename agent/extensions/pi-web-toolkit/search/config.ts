import type { SearchConfig } from './types'

export function buildSearchConfig(ext: Record<string, unknown>): Partial<{ search: SearchConfig }> {
  const r: Partial<{ search: SearchConfig }> = {}
  const s: { searxng_url?: string; timeout?: number } = {}
  if (ext.searxng_url) s.searxng_url = ext.searxng_url as string
  if (ext.search_timeout) s.timeout = ext.search_timeout as number
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
