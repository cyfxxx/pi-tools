export async function searchDirect(query: string, maxResults = 5): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return `搜索失败: HTTP ${res.status}`
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
