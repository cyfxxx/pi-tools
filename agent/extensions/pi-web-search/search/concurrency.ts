// ── 并发限制器（wechat-article-exporter P-Queue 启发）────────────
// 限制同时进行的异步操作数量，防止批量请求时 IP 被封或资源耗尽。
// 适用于：批量 URL 抓取、知识源并发拉取、多引擎搜索等场景。

export interface ConcurrencyLimiter {
  /** 当前正在执行的任务数 */
  readonly running: number
  /** 队列中等待的任务数 */
  readonly queued: number
  /** 执行一个任务（自动排队，完成后自动释放槽位） */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** 排空队列（等待所有已提交任务完成） */
  drain(): Promise<void>
}

export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  if (maxConcurrent < 1) throw new Error('maxConcurrent 必须 ≥ 1')

  let running = 0
  const queue: Array<() => void> = []

  function acquire(): Promise<void> {
    if (running < maxConcurrent) {
      running++
      return Promise.resolve()
    }
    return new Promise(resolve => queue.push(resolve))
  }

  function release(): void {
    running--
    if (queue.length > 0) {
      running++
      queue.shift()!()
    }
  }

  return {
    get running() { return running },
    get queued() { return queue.length },

    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },

    async drain(): Promise<void> {
      // 等待队列清空即可（running 会在每次 release 后自动递减）
      while (running > 0 || queue.length > 0) {
        await new Promise(r => setTimeout(r, 50))
      }
    },
  }
}

// ── 带重试的批量 fetch（组合 fetchWithRetry + ConcurrencyLimiter）─

export interface BatchFetchOptions {
  /** 最大并发数（默认 3） */
  concurrency?: number
  /** 单个请求超时 ms（默认 15000） */
  timeout?: number
  /** 最大重试次数（默认 2） */
  maxRetries?: number
  /** 自定义 headers */
  headers?: Record<string, string>
}

export interface BatchFetchResult {
  url: string
  ok: boolean
  status: number
  text: string
  durationMs: number
}

/**
 * 批量并发 fetch，带并发限制和重试。
 * 适用于知识源批量拉取、文章批量下载等场景。
 */
export async function batchFetch(
  urls: string[],
  options: BatchFetchOptions = {},
): Promise<BatchFetchResult[]> {
  const {
    concurrency = 3,
    timeout = 15000,
    maxRetries = 2,
    headers = {},
  } = options

  const limiter = createConcurrencyLimiter(concurrency)
  const results: BatchFetchResult[] = []

  const tasks = urls.map(url =>
    limiter.run(async () => {
      const start = Date.now()
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'pi-web-search/1.0', ...headers },
          })

          clearTimeout(timer)

          // 4xx 不重试
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            results.push({
              url,
              ok: false,
              status: res.status,
              text: await res.text().catch(() => ''),
              durationMs: Date.now() - start,
            })
            return
          }

          // 5xx / 429 重试
          if (!res.ok && attempt < maxRetries) {
            const delay = Math.min(500 * Math.pow(2, attempt), 4000)
            await new Promise(r => setTimeout(r, delay))
            continue
          }

          results.push({
            url,
            ok: res.ok,
            status: res.status,
            text: await res.text().catch(() => ''),
            durationMs: Date.now() - start,
          })
          return
        } catch (e) {
          clearTimeout(timer)
          lastError = e instanceof Error ? e : new Error(String(e))

          if (attempt < maxRetries) {
            const delay = Math.min(500 * Math.pow(2, attempt), 4000)
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }

      // 所有重试耗尽
      results.push({
        url,
        ok: false,
        status: 0,
        text: lastError?.message || 'unknown error',
        durationMs: Date.now() - start,
      })
    })
  )

  await Promise.allSettled(tasks)
  return results
}
