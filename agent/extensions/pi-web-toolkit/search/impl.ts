import type { SearchConfig, SearchResponse } from './types'

async function fetchWithRetry(
  url: string,
  opts: { signal: AbortSignal; headers: Record<string, string> },
  maxRetries = 1,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (res.ok || attempt >= maxRetries) return res
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    } catch (e) {
      if (attempt >= maxRetries) throw e
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  throw new Error('重试耗尽')
}

export async function searchWeb(
  config: SearchConfig,
  query: string,
  options?: {
    engines?: string[]
    categories?: string
    pageno?: number
    time_range?: string
    lang?: string
    max_results?: number
    brief?: boolean
  },
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return '搜索已取消。'

  const params = new URLSearchParams({ format: 'json', q: query })

  if (options?.categories) params.set('categories', options.categories)
  if (options?.pageno) params.set('pageno', String(options.pageno))
  if (options?.time_range) params.set('time_range', options.time_range)
  if (options?.lang) params.set('lang', options.lang)
  if (options?.engines?.length) params.set('engines', options.engines.join(','))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout)

  const onAbort = () => {
    clearTimeout(timer)
    controller.abort()
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetchWithRetry(
      `${config.searxng_url}/search?${params}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'pi-web-toolkit/1.0' },
      },
      1,
    )

    if (!res.ok) {
      return `搜索失败: SearXNG 返回 ${res.status} ${res.statusText}。请检查 searxng_url 配置是否正确。`
    }

    const data: SearchResponse = await res.json()
    return formatResponse(data, query, options?.max_results ?? 5, options?.brief ?? false)
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      if (signal?.aborted) return '搜索已取消。'
      return `搜索超时 (${config.timeout}ms)。请检查 SearXNG 实例 ${config.searxng_url} 是否可达。`
    }
    return `搜索失败: ${(err as Error).message}`
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function formatResponse(data: SearchResponse, query: string, maxResults: number = 5, brief: boolean = false): string {
  const lines: string[] = []
  lines.push(`搜索: "${query}"`, '')

  const results = data.results ?? []
  const answers = data.answers ?? []
  const suggestions = data.suggestions ?? []
  const corrections = data.corrections ?? []
  const unresponsive = data.unresponsive_engines ?? []
  const infoboxes = data.infoboxes ?? []

  if (brief && results.length > 0) {
    lines.push(`找到 ${data.number_of_results ?? results.length} 条结果（简要模式）：`)
    lines.push('')
    for (const r of results.slice(0, maxResults)) {
      const tag = r.engine ? ` [${r.engine}]` : ''
      lines.push(`- ${r.title}${tag}`)
      lines.push(`  ${r.url}`)
    }
    if (results.length > maxResults) {
      lines.push(`  ... 还有 ${results.length - maxResults} 条结果。使用 max_results:N 展开更多。`)
    }
    if (answers.length > 0) {
      lines.push('')
      lines.push('直接答案：')
      for (const a of answers) lines.push(`- ${a}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  if (results.length > 0) {
    lines.push(`找到 ${data.number_of_results ?? results.length} 条结果：`)
    lines.push('')
    for (const r of results.slice(0, maxResults)) {
      const tag = r.engine ? ` [${r.engine}]` : ''
      lines.push(`### ${r.title}${tag}`)
      lines.push(r.url)
      if (r.content) lines.push(truncate(r.content, 250))
      if (r.publishedDate) lines.push(`时间: ${r.publishedDate}`)
      lines.push('')
    }
    if (results.length > maxResults) {
      lines.push(`... 还有 ${results.length - maxResults} 条结果未显示。使用 max_results:N 查看更多。`)
    }
  } else {
    lines.push('未找到结果。')
  }

  if (answers.length > 0) {
    lines.push('---\n直接答案：')
    for (const a of answers) lines.push(`- ${a}`)
    lines.push('')
  }

  if (suggestions.length > 0) {
    lines.push('搜索建议：`' + suggestions.join('` `') + '`')
    lines.push('')
  }

  if (corrections.length > 0) {
    lines.push('拼写纠正：')
    for (const c of corrections) lines.push(`- ${c}`)
    lines.push('')
  }

  if (unresponsive.length > 0) {
    lines.push(`⚠ 以下引擎无响应：${unresponsive.join('、')}`)
    lines.push('可尝试减少 engines 参数或切换 categories。')
    lines.push('')
  }

  if (infoboxes.length > 0) {
    lines.push('信息框：')
    for (const ib of infoboxes) {
      lines.push(`- ${ib.title ?? ib.content ?? JSON.stringify(ib)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '...'
}
