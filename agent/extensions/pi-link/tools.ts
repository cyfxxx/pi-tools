/**
 * pi-link tools — link_send, link_status
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { LinkConfig } from './config.ts'
import { getDevice, describeDevice } from './config.ts'
import { probeDevice, sendToDevice, type SendOptions } from './link.ts'
import { readActive, isActive, isUnattendedEnv } from './active.ts'
import { fmtResult, ok, err, listDevices } from './helpers.ts'

export function registerLinkTools(pi: ExtensionAPI, getCfg: () => LinkConfig, refreshCfg: () => void, me: string): void {
  pi.registerTool({
    name: 'link_send',
    label: '向其他设备上的 pi 发消息',
    description:
      '向其他设备（局域网/Tailscale）上的 pi 发送消息并等待处理完成。用于跨设备委派/查询。设备清单在 ~/.pi/pi-link.json，/link help 查看用法。',
    promptSnippet: '调用其他设备上的 pi 处理任务',
    promptGuidelines: [
      '仅当任务需要远程 pi 自主处理（多步操作/判断/纠错/出报告）时用 link_send；单条确定性命令直接用 bash 执行 ssh，更快更省 token',
      '先 link_status 确认设备可达再 link_send；离线或超时返回错误后不要反复重试',
    ],
    parameters: {
      type: 'object',
      properties: {
        device: { type: 'string', description: '目标设备别名（pi-link.json 中的键，如 phone/laptop）' },
        message: { type: 'string', description: '要发送给远程 pi 的消息/任务指令' },
        timeoutSec: { type: 'number', description: '覆盖默认超时（秒），默认 600' },
      },
      required: ['device', 'message'],
    },
    async execute(_id, params, signal, onUpdate) {
      refreshCfg()
      const cfg = getCfg()
      const name = String((params as Record<string, unknown>).device ?? '')
      const message = String((params as Record<string, unknown>).message ?? '')
      if (!name) return err('缺少 device 参数。用法: link_send <device> <message>（/link help 查看全部）')
      if (!message) return err('缺少 message 参数。用法: link_send <device> <message>')
      const dev = getDevice(cfg, name)
      if (!dev) return err(`未知设备 "${name}"。已配置: ${listDevices(cfg)}。请在 ~/.pi/pi-link.json 添加或查看 /link status`)
      const active = readActive()
      if ((isUnattendedEnv() || !isActive(active)) && !(cfg.allowUnattended ?? false)) {
        const why = isUnattendedEnv()
          ? '当前是无人值守执行（定时任务）'
          : `本机最近用户交互在 ${active ? Math.round((Date.now() - active.lastActiveAt) / 60000) : '未知'} 分钟前`
        return err(`${why}，跨设备指令已拒绝（防无人值守乱指挥）。` +
          '可在 ~/.pi/pi-link.json 设 allowUnattended: true 允许，或在本机输入后重试。')
      }
      const t = (params as Record<string, unknown>).timeoutSec
      const opts = typeof t === 'number' && t > 0 ? { timeoutSec: Math.max(60, t) } : {}
      const sendOpts: SendOptions = { ...opts, fromName: me, signal }
      sendOpts.onEvent = (ev) => {
        let line: string | undefined
        if (ev.type === 'tool_execution_start') {
          const m = (ev as Record<string, unknown>).toolName ?? (ev as Record<string, unknown>).name
          line = `→ 远程正在执行: ${String(m ?? '工具')}`
        } else if (ev.type === 'tool_execution_update') {
          const u = (ev as Record<string, unknown>).partialResult
          if (typeof u === 'string' && u) line = u.slice(0, 200)
        } else if (ev.type === 'turn_end') {
          line = '→ 远程一轮工具交互完成'
        } else if (ev.type === 'agent_settled') {
          line = '→ 远程任务完成'
        }
        if (line && onUpdate) {
          onUpdate({ content: [{ type: 'text', text: line }], details: null })
        }
      }
      try {
        const r = await sendToDevice(dev, message, sendOpts, cfg.defaultTimeoutSec)
        return ok(fmtResult(r), { device: name, ...r })
      } catch (e) {
        return err(`link_send 失败: ${(e as Error).message}`)
      }
    },
  })

  pi.registerTool({
    name: 'link_status',
    label: '查看 pi-link 设备清单与连通性',
    description: '查看 pi-link 设备清单与连通性（探测失败仅表示目标离线或 ssh 不可达，不影响本机）',
    promptSnippet: '查看已配置的互联设备',
    parameters: { type: 'object', properties: {} },
    async execute() {
      refreshCfg()
      const cfg = getCfg()
      const names = Object.keys(cfg.devices)
      if (names.length === 0) {
        return ok('未配置任何设备。在 ~/.pi/pi-link.json 添加（参考 /link help）后重试。')
      }
      const lines: string[] = [`已配置 ${names.length} 台设备:`]
      const results = await Promise.allSettled(names.map((n) => probeDevice(cfg.devices[n])))
      names.forEach((n, i) => {
        const d = cfg.devices[n]
        const r = results[i].status === 'fulfilled'
          ? results[i].value
          : { ok: false, latencyMs: 0, detail: String((results[i] as PromiseRejectedResult).reason) }
        lines.push(`  ${r.ok ? '●' : '○'} ${describeDevice(n, d)} — ${r.ok ? `可达 ${r.latencyMs}ms` : `不可达: ${r.detail ?? ''}`}`)
      })
      return ok(lines.join('\n'))
    },
  })
}
