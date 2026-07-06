import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback, ToolResult } from '@earendil-works/pi-coding-agent'
import type { ProxyPool } from './pool'

function toolResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

export function registerProxyControlTools(
  pi: ExtensionAPI,
  ensureProxy: () => Promise<boolean>,
  proxyPool: ProxyPool | null,
): void {
  pi.registerTool({
    name: 'proxy_status',
    label: '代理状态',
    description: '查看代理控制系统的运行状态：代理总数、存活/失效数量、平均延迟、当前策略、系统代理开关状态、各代理详情。',
    promptSnippet: '查看代理控制系统的运行状态和统计数据',
    parameters: { type: 'object', properties: {} },
    execute: async (
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      const s = await proxyPool!.getStats()
      const lines: string[] = []
      lines.push(`代理池状态 (策略: ${s.strategy})`)
      lines.push(`├─ 当前代理: ${s.current || 'none'}`)
      lines.push(`├─ 总计: ${s.total}`)
      lines.push(`├─ 存活: ${s.alive}`)
      lines.push(`├─ 失效: ${s.dead}`)
      lines.push(`├─ 平均延迟: ${s.avgLatency}ms`)
      lines.push(`├─ 系统代理: ${s.systemProxyEnabled ? '✓ 已启用' : '✗ 已禁用'}`)
      lines.push(`└─ 代理地址: ${s.systemProxyUrl || '-'}`)
      lines.push('')
      for (const e of s.entries) {
        const icon = e.isCurrent ? '➡️' : '🟢'
        const lat = e.latency > 0 ? `${e.latency}ms` : '-'
        lines.push(`${icon} ${e.url}  延迟:${lat}  失败:${e.failures}`)
      }
      return toolResult(lines.join('\n'))
    },
  })

  pi.registerTool({
    name: 'proxy_add',
    label: '添加代理',
    description: '向代理池中添加一个或多个代理。支持 HTTP/HTTPS/SOCKS 协议，每行一个。',
    promptSnippet: '手动向代理池添加代理地址',
    parameters: {
      type: 'object',
      properties: {
        proxies: {
          type: 'array',
          items: { type: 'string' },
          description: '代理 URL 数组，如 ["http://user:pass@1.2.3.4:8080", "socks5://5.6.7.8:1080"]',
        },
      },
      required: ['proxies'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      const list = params.proxies as string[]
      await proxyPool!.addProxies(list)
      const s = await proxyPool!.getStats()
      return toolResult(`已添加 ${list.length} 个代理。当前池: ${s.alive}/${s.total} 存活，当前: ${s.current || 'none'}。`)
    },
  })

  pi.registerTool({
    name: 'proxy_rotate',
    label: '轮转代理',
    description: '强制轮转当前代理，切换至池中另一个可用代理。如果系统代理已启用，环境变量将立即指向新代理。',
    promptSnippet: '强制切换当前代理',
    parameters: { type: 'object', properties: {} },
    execute: async (
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      const p = await proxyPool!.rotate()
      if (p) return toolResult(`已轮转至代理: ${p}`)
      return toolResult('无可用的代理进行轮转。')
    },
  })

  pi.registerTool({
    name: 'proxy_on',
    label: '启用系统代理',
    description: '启用系统级代理。自动启动 sing-box（如未运行），设置 HTTP_PROXY/HTTPS_PROXY 环境变量指向代理。启用后当前进程及所有子进程的网络流量都将通过代理发出。',
    promptSnippet: '启用系统级代理，所有网络流量走代理',
    parameters: { type: 'object', properties: {} },
    execute: async (
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      if (!proxyPool!.isRunning()) {
        await proxyPool!.init()
      }
      proxyPool!.enableSystemProxy()
      return toolResult(`系统代理已启用: ${proxyPool!.getLocalProxyUrl()}\n当前进程及子进程的网络流量将通过代理发出。`)
    },
  })

  pi.registerTool({
    name: 'proxy_off',
    label: '禁用系统代理',
    description: '禁用系统级代理。清空 HTTP_PROXY/HTTPS_PROXY 环境变量并停止 sing-box 子进程。',
    promptSnippet: '禁用系统级代理，停止 sing-box',
    parameters: { type: 'object', properties: {} },
    execute: async (
      _toolCallId: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      proxyPool!.disableSystemProxy()
      proxyPool!.stop()
      return toolResult('系统代理已禁用，sing-box 已停止。')
    },
  })

  pi.registerTool({
    name: 'proxy_set',
    label: '设置代理',
    description: '添加一个代理地址到代理池并自动选中它，同时启用系统代理。等价于 proxy_add + 自动选中 + proxy_on 的组合操作。',
    promptSnippet: '添加代理并立即启用为系统代理',
    parameters: {
      type: 'object',
      properties: {
        proxy: {
          type: 'string',
          description: '代理 URL，如 "http://user:pass@1.2.3.4:8080" 或 "socks5://5.6.7.8:1080"',
        },
      },
      required: ['proxy'],
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      if (!(await ensureProxy())) return toolResult('代理池未配置或启动失败。')
      const url = params.proxy as string
      await proxyPool!.addProxies([url])
      const rotated = await proxyPool!.rotate()
      if (!proxyPool!.isRunning()) {
        await proxyPool!.init()
      }
      proxyPool!.enableSystemProxy()
      return toolResult(`已添加代理 ${url} 并启用系统代理。当前代理: ${rotated || url}\n系统代理地址: ${proxyPool!.getLocalProxyUrl()}`)
    },
  })
}
