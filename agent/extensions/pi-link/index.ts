import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig, getDevice, describeDevice, type DeviceConfig, type LinkConfig } from './config'
import { sendToDevice, probeDevice, watchRemote, attachToRemote, readRemoteState, type SendOptions } from './link'
import { touchActive, isActive, readActive, selfName, isUnattendedEnv } from './active'
import { writeLocalState } from './state-writer'

/**
 * pi-link — 多设备 pi 互联扩展
 *
 * 让本机 pi 直接与其他设备（局域网 / Tailscale 组网）上运行的 pi 通信：
 * - `link_send <device> <message>`：向目标设备的 pi 发消息，等待其处理完成并返回最终回复
 * - `link_status`：设备清单与连通性
 * 链路：本机 → ssh → 远程 `pi --mode rpc`（JSONL 协议，官方通道）
 * 安全：SSH 密钥认证；远程默认 --no-extensions（不暴露远程记忆/不触发 plan-mode/autopilot）
 */

function fmtResult(r: { ok: boolean; reply?: string; turns: number; tools: number; durationSec: number; error?: string; model?: string }): string {
  const head = `[完成] ${r.durationSec}s, ${r.turns} 轮工具交互, ${r.tools} 次工具调用${r.model ? `, 模型 ${r.model}` : ''}`
  if (!r.ok) return `${head}\n错误: ${r.error}`
  return `${head}\n${r.reply}`
}

export default function (pi: ExtensionAPI): void {
  const cfg = loadConfig()
  const me = selfName(cfg.selfName)

  // T2-1 活跃机制：用户输入（消息/命令）刷新本机活跃时间戳
  pi.on('input', async (event: { text?: string }) => {
    const text = typeof event?.text === 'string' ? event.text : ''
    touchActive(me, text)
  })

  // T2-2 远程状态维护：记录本机 agent 运行状态与当前会话（其他设备 attach/watch 用）
  // 会话文件路径在 session_start 时不可直接取（事件不含 filePath），
  // 由 turn_start 时探测当前会话目录最新文件兜底（attach/watch 侧同样有兜底）。
  pi.on('turn_start', async () => {
    writeLocalState({ device: me, status: 'busy' })
  })
  pi.on('agent_settled', async () => {
    writeLocalState({ device: me, status: 'idle' })
  })

  pi.registerTool({
    name: 'link_send',
    label: '向其他设备上的 pi 发消息',
    description:
      '向其他设备（局域网/Tailscale 组网）上运行的 pi 发送消息并等待其处理完成，返回最终回复。' +
      '用于跨设备任务委派/信息查询。设备清单在 ~/.pi/pi-link.json，/link help 查看全部用法。',
    promptSnippet: '调用其他设备上的 pi 处理任务',
    promptGuidelines: [
      '跨设备任务（目标设备上才能做的操作、需要目标设备上下文的问题）用 link_send，其余本地处理',
      '目标设备离线或超时会返回错误，不要反复重试',
      '先 link_status 确认设备可达再 link_send',
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
    async execute(_id, params, _signal, onUpdate) {
      const name = String((params as Record<string, unknown>).device ?? '')
      const message = String((params as Record<string, unknown>).message ?? '')
      if (!name) return err('缺少 device 参数。用法: link_send <device> <message>（/link help 查看全部）')
      if (!message) return err('缺少 message 参数。用法: link_send <device> <message>')
      const dev = getDevice(cfg, name)
      if (!dev) return err(`未知设备 "${name}"。已配置: ${listDevices(cfg)}。请在 ~/.pi/pi-link.json 添加或查看 /link status`)
      // T2-1 活跃校验：无人值守环境（定时任务）或本机长期无用户交互时默认拒绝
      const active = readActive()
      if ((isUnattendedEnv() || !isActive(active)) && !(cfg.allowUnattended ?? false)) {
        const why = isUnattendedEnv()
          ? '当前是无人值守执行（定时任务）'
          : `本机最近用户交互在 ${active ? Math.round((Date.now() - active.lastActiveAt) / 60000) : '未知'} 分钟前`
        return err(`${why}，跨设备指令已拒绝（防无人值守乱指挥）。` +
          '可在 ~/.pi/pi-link.json 设 allowUnattended: true 允许，或在本机输入后重试。')
      }
      const t = (params as Record<string, unknown>).timeoutSec
      // 下限保护：远程 RPC 启动 + LLM 会话通常需 60s+，防止模型传过小值导致必失败
      const opts = typeof t === 'number' && t > 0 ? { timeoutSec: Math.max(60, t) } : {}
      // 流式回传（T1-2）：远程工具执行进度实时转发
      const sendOpts: SendOptions = { ...opts, fromName: name }
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
        const r = await sendToDevice(dev, message, sendOpts)
        return ok(fmtResult(r), { device: name, ...r })
      } catch (e) {
        return err(`link_send 失败: ${(e as Error).message}`)
      }
    },
  })

  pi.registerTool({
    name: 'link_status',
    label: '查看 pi-link 设备清单与连通性',
    description: '查看 pi-link 设备清单与连通性（探测失败仅表示目标设备离线或 ssh 不可达，不影响本机）',
    promptSnippet: '查看已配置的互联设备',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const names = Object.keys(cfg.devices)
      if (names.length === 0) {
        return ok('未配置任何设备。在 ~/.pi/pi-link.json 添加（参考 /link help）后重试。')
      }
      const lines: string[] = [`已配置 ${names.length} 台设备:`]
      for (const n of names) {
        const d = cfg.devices[n]
        const r = await probeDevice(d)
        lines.push(`  ${r.ok ? '●' : '○'} ${describeDevice(n, d)} — ${r.ok ? `可达 ${r.latencyMs}ms` : `不可达: ${r.detail ?? ''}`}`)
      }
      return ok(lines.join('\n'))
    },
  })

  pi.registerCommand('link', {
    description: '多设备互联: /link send <设备> <消息> | status | help（pi-link 扩展）',
    getArgumentCompletions: (prefix) => {
      const p = prefix ?? ''
      const parts = p.trim().split(/\s+/)
      const first = parts[0] ?? ''
      if (!p.includes(' ')) {
        return ['send', 'status', 'help']
          .filter((c) => c.startsWith(first))
          .map((c) => ({ value: c + (c === 'send' ? ' ' : ''), label: c, description: c === 'send' ? '向设备发消息' : c === 'status' ? '设备清单与连通性' : '用法' }))
      }
      if (first === 'send' && parts.length === 2) {
        const sub = parts[1] ?? ''
        return Object.keys(cfg.devices).filter((d) => d.startsWith(sub)).map((d) => ({
          value: d + ' ',
          label: d,
          description: describeDevice(d, cfg.devices[d]),
        }))
      }
      return []
    },
    handler: async (args: string, ctx) => {
      const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'help'
      const output = async (text: string) => {
        pi.sendMessage({ customType: 'pi-link', content: text, display: true }, { triggerTurn: false })
      }
      if (sub === 'help' || sub === '-h' || sub === '--help') {
        await output(helpText())
        return
      }
      if (sub === 'status') {
        const names = Object.keys(cfg.devices)
        if (names.length === 0) {
          ctx.ui.notify('未配置任何设备。编辑 ~/.pi/pi-link.json 添加（见 /link help）。', 'info')
          return
        }
        const lines = [`已配置 ${names.length} 台设备:`]
        for (const n of names) {
          const d = cfg.devices[n]
          const r = await probeDevice(d)
          lines.push(`  ${r.ok ? '●' : '○'} ${describeDevice(n, d)} — ${r.ok ? `可达 ${r.latencyMs}ms` : `不可达: ${r.detail ?? ''}`}`)
        }
        await output(lines.join('\n'))
        return
      }
      if (sub === 'send') {
        const device = parts[1]
        const message = parts.slice(2).join(' ')
        if (!device || !message) {
          ctx.ui.notify('用法: /link send <设备> <消息>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        // 命令路径同样做活跃校验
        const active = readActive()
        if ((isUnattendedEnv() || !isActive(active)) && !(cfg.allowUnattended ?? false)) {
          ctx.ui.notify('无人值守环境或本机长时间无交互，跨设备指令已拒绝（allowUnattended 可配置）', 'warning')
          return
        }
        const r = await sendToDevice(dev, message, { fromName: me })
        await output(fmtResult(r))
        return
      }
      if (sub === 'watch') {
        const device = parts[1]
        const lines = parts.includes('--lines') ? parseInt(parts[parts.indexOf('--lines') + 1] ?? '30', 10) || 30 : 30
        if (!device) {
          ctx.ui.notify('用法: /link watch <设备> [--lines N]', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const r = await watchRemote(dev, lines)
        await output(r.ok ? `远程 ${device} 会话尾部（${lines} 行）:\n\n${r.text}` : `观察失败: ${r.error}`)
        return
      }
      if (sub === 'attach') {
        const force = parts.includes('--force')
        const rest = parts.filter((x) => x !== '--force')
        const device = rest[1]
        const text = rest.slice(2).join(' ')
        if (!device || !text) {
          ctx.ui.notify('用法: /link attach <设备> [--force] <要输入的文本>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        // 冲突防护：远程 busy 时拒绝（--force 打断）
        const { state } = await readRemoteState(dev)
        if (state?.status === 'busy' && !force) {
          ctx.ui.notify(`远程 ${device} 正在执行任务（${state.currentTask ?? '未知'}），已拒绝介入。加 --force 强制打断。`, 'warning')
          return
        }
        const r = await attachToRemote(dev, text, state?.tmuxSession)
        await output(r.ok ? r.detail : `介入失败: ${r.detail}`)
        return
      }
      ctx.ui.notify(`未知子命令 "${sub}"。用法见 /link help`, 'warning')
    },
  })
}

function ok(text: string, details?: unknown) {
  return { content: [{ type: 'text' as const, text }], details: details ?? null }
}
function err(text: string) {
  return { content: [{ type: 'text' as const, text }], details: null, isError: true }
}
function listDevices(cfg: LinkConfig): string {
  return Object.keys(cfg.devices).join(', ') || '(无)'
}
function helpText(): string {
  return [
    'pi-link 多设备互联：让本机 pi 与其他设备（局域网/Tailscale）的 pi 通信',
    '',
    '用法:',
    '  /link send <设备> <消息>   向目标设备的 pi 发送消息并等待回复（无人值守拒绝）',
    '  /link watch <设备> [--lines N]   观察远程 pi 会话尾部（模型间沟通可见）',
    '  /link attach <设备> [--force] <文本>   介入远程 pi 输入框（busy 拒绝/--force）',
    '  /link status               设备清单与连通性探测',
    '  /link help                 本帮助',
    '',
    '工具:',
    '  link_send(device, message, timeoutSec?)  — 同上，供模型直接调用',
    '  link_status()                            — 设备清单与连通性',
    '',
    '配置 ~/.pi/pi-link.json（示例）:',
    '  { "devices": { "phone": { "host": "100.101.102.103", "user": "u0_a123",',
    '      "port": 8022, "timeoutSec": 600 } } }',
    '',
    '安全:',
    '  · 走 SSH 密钥认证（建议 Tailscale 私有网络内使用）',
    '  · 远程默认 --no-extensions 启动（不暴露远程记忆、不触发 plan-mode/autopilot）',
    '  · 加固可选: 目标设备 authorized_keys 用 command="~/.pi/scripts/pi-link-entry.sh" 限制',
  ].join('\n')
}

export type { DeviceConfig, LinkConfig }
