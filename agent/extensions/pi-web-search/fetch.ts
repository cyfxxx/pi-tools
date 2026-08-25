export async function searchDirect(query: string, maxResults = 5, signal?: AbortSignal): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  // 审计修复：用户停止生成（signal）转发到内部 controller，与 10s 内部超时
  // 任一触发即中断（与 fetch_url 同模式）；abort 均从 fetch 抛 AbortError
  const onUserAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onUserAbort)
  try {
    return await doSearch(url, maxResults, query, controller.signal)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener?.('abort', onUserAbort)
  }
}

async function doSearch(
  url: string,
  maxResults: number,
  query: string,
  reqSignal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    signal: reqSignal,
  })
  // fetch 失败必抛异常（网络/DNS/超时 abort），不会返回 null——此分支为死代码，已移除
  if (!res.ok) {
    // 取消未消费的响应体，避免连接悬挂（socket 无法复用/泄漏）
    try { await res.body?.cancel() } catch { /* 已释放 */ }
    return `搜索失败: HTTP ${res.status}`
  }
  const html = await res.text()
  const results: string[] = []
  const linkRe = /<h2><a href="(https?:\/\/[^"]+)"[^>]*>(.+?)<\/a>/g
  let match: RegExpExecArray | null
  let count = 0
  while ((match = linkRe.exec(html)) !== null && count < maxResults) {
    const title = match[2].replace(/<[^>]+>/g, "").trim()
    if (title) {
      results.push(`${count + 1}. ${title}`)
      results.push(`   ${match[1]}`)
      count++
    }
  }
  if (results.length === 0) {
    return `搜索 "${query}" 无结果（Bing 可能返回了验证页面）`
  }
  return `搜索: "${query}"\n\n${results.join("\n")}`
}
