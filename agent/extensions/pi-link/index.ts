import { execSync } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadConfig, configPath, getDevice, describeDevice, saveDevice, type DeviceConfig, type LinkConfig } from './config.ts'
import { sendToDevice, probeDevice, watchRemote, attachToRemote, readRemoteState, readRemoteOutbox, type SendOptions } from './link.ts'
import { touchActive, isActive, readActive, selfName, isUnattendedEnv } from './active.ts'
import { writeLocalState } from './state-writer.ts'
import { appendOutbox, extractFinalReply, OUTBOX_MAX } from './outbox.ts'
import { buildCard, validateCard, cardToDevice } from './card.ts'

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

function cfgPathOf(): string {
  return process.env.PI_LINK_CONFIG ?? configPath()
}

export default function (pi: ExtensionAPI): void {
  let cfg = loadConfig()
  const me = selfName(cfg.selfName)
  // 配置热更新：工具/命令执行前重读 pi-link.json（编辑文件或 import-card 后无需重启 pi）
  const refreshCfg = (): void => { cfg = loadConfig() }

  // 探测本机 tmux 会话名（其他设备 attach 时定位输入框）。
  // 审计：启动时一次性捕获——tmux 会话改名（rename-session / resurrect 恢复）后
  // 快照失效，远程 attach 打错目标。探测廉价（本地 execSync；非 tmux 环境零开销），
  // 改为惰性重探：每次状态回写时重新执行。
  // 审计 LOW（2026-08-26）：turn_start/agent_settled 每轮同步 execSync 最长阻塞事件循环
  // 3s（tmux 挂起时）——加 30s TTL 缓存：正常路径仍每轮刷新，异常路径不再反复阻塞。
  // 审计 LOW（2026-08-26）：turn_start/agent_settled 每轮同步 execSync 在 tmux 挂起时
  // 最长阻塞事件循环 3s —— 仅失败/超时后缓存“无 tmux”结果 60s，避免反复阻塞；
  // 成功路径不缓存（保持“改名即时跟进”既有审计契约，且正常探测耗时毫秒级）。
  let tmuxFailCache = 0
  const TMUX_FAIL_TTL_MS = 60_000
  function detectTmuxSession(): string | undefined {
    if (Date.now() - tmuxFailCache < TMUX_FAIL_TTL_MS) return undefined
    try {
      if (process.env.TMUX) {
        const out = execSync('tmux display-message -p "#S" 2>/dev/null', { timeout: 3000 }).toString().trim()
        if (out) return out
      }
    } catch {
      // 非 tmux 环境或 tmux 挂起：后者缓存避免每轮阻塞 3s
      if (process.env.TMUX) tmuxFailCache = Date.now()
    }
    return undefined
  }
  const tmuxSessionOf = (): string | undefined => detectTmuxSession()

  // T2-1 活跃机制：用户输入（消息/命令）刷新本机活跃时间戳
  pi.on('input', async (event: { text?: string }) => {
    const text = typeof event?.text === 'string' ? event.text : ''
    touchActive(me, text)
  })

  // T2-3 信箱：agent 一轮结束的最终回复写入本机信箱（其他设备 /link inbox 可查）
  pi.on('agent_end', async (e: { messages: unknown[] }) => {
    const text = extractFinalReply(e?.messages)
    if (text) appendOutbox(me, text)
  })

  // T2-2 远程状态维护：记录本机 agent 运行状态与 tmux 会话（其他设备 attach/watch 用）
  writeLocalState({ device: me, status: 'idle', tmuxSession: tmuxSessionOf() })
  pi.on('turn_start', async () => {
    writeLocalState({ device: me, status: 'busy', tmuxSession: tmuxSessionOf() })
  })
  pi.on('agent_settled', async () => {
    writeLocalState({ device: me, status: 'idle', tmuxSession: tmuxSessionOf() })
  })

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
      // 审计 MEDIUM 修复：把宿主取消信号接入发送链路（中止后杀 ssh、释放 inflight 锁）
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
      const names = Object.keys(cfg.devices)
      if (names.length === 0) {
        return ok('未配置任何设备。在 ~/.pi/pi-link.json 添加（参考 /link help）后重试。')
      }
      const lines: string[] = [`已配置 ${names.length} 台设备:`]
      // 审计：串行 probeDevice（每地址最长 8s）多设备时 status 耗时线性累积——
      // 改 Promise.allSettled 并发探测，结果按 names 顺序保序展示
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
      refreshCfg()
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
        // 审计：与 link_status 工具同改——并发探测、保序展示
        const results = await Promise.allSettled(names.map((n) => probeDevice(cfg.devices[n])))
        names.forEach((n, i) => {
          const d = cfg.devices[n]
          const r = results[i].status === 'fulfilled'
            ? results[i].value
            : { ok: false, latencyMs: 0, detail: String((results[i] as PromiseRejectedResult).reason) }
          lines.push(`  ${r.ok ? '●' : '○'} ${describeDevice(n, d)} — ${r.ok ? `可达 ${r.latencyMs}ms` : `不可达: ${r.detail ?? ''}`}`)
        })
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
        const r = await sendToDevice(dev, message, { fromName: me }, cfg.defaultTimeoutSec)
        await output(fmtResult(r))
        return
      }
      if (sub === 'watch') {
        const device = parts[1]
        const rawLines = parts.includes('--lines') ? parseInt(parts[parts.indexOf('--lines') + 1] ?? '30', 10) : 30
        const lines = Number.isNaN(rawLines) || rawLines < 1 ? 30 : Math.min(rawLines, 200)
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
      if (sub === 'inbox') {
        const device = parts[1]
        if (!device) {
          ctx.ui.notify('用法: /link inbox <设备>', 'warning')
          return
        }
        const dev = getDevice(cfg, device)
        if (!dev) {
          ctx.ui.notify(`未知设备 "${device}"。已配置: ${listDevices(cfg)}`, 'warning')
          return
        }
        const r = await readRemoteOutbox(dev)
        if (!r.ok) {
          await output(`读取失败: ${r.detail}`)
          return
        }
        const body = r.entries.length === 0
          ? '（空）'
          : r.entries.map((en, i) => `[${new Date(en.ts).toLocaleTimeString()}] ${en.text.slice(0, 300)}`).join('\n\n')
        await output(`远程 ${device} 信箱（${r.entries.length}/${OUTBOX_MAX} 条）：\n${body}`)
        return
      }
      if (sub === 'export-card') {
        const card = buildCard(cfg)
        await output('本机设备卡片（复制给其他设备 import-card）：\n' + JSON.stringify(card, null, 2))
        return
      }
      if (sub === 'import-card') {
        // 审计：旧 parts.slice(2) 是 off-by-one（对照 send 分支 parts.slice(2) 语义不同：
        // 卡片参数从 parts[1] 起），导致首位 token 被吞；且 split/重 join 会破坏 JSON
        // 内连续空格。改从原始命令串按首个空格切分取余串。
        const raw = (args ?? '').trim().slice(sub.length).trim()
        if (!raw) {
          ctx.ui.notify('用法: /link import-card <卡片JSON>（可用 /link export-card 生成）', 'warning')
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          ctx.ui.notify('卡片不是合法 JSON', 'warning')
          return
        }
        const v = validateCard(parsed)
        if (!v.ok || !v.card) {
          ctx.ui.notify(`卡片无效: ${v.detail}`, 'warning')
          return
        }
        const r = saveDevice(cfgPathOf(), v.card.name, cardToDevice(v.card))
        // 配置由 refreshCfg 在下次工具/命令调用时重读，无需手动同步内存
        await output(r.detail)
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
        // 冲突防护：远程 busy 时拒绝（--force 打断）——校验在 attachToRemote 内；
        // 自动附加本机身份前缀（attachToRemote 内部处理）
        const r = await attachToRemote(dev, text, undefined, force, me)
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
    '  /link inbox <设备>         读取远程信箱（远程自主完成的回复记录）',
    '  /link export-card         生成本机设备卡片（含 IP/用户）',
    '  /link import-card <JSON>  导入设备卡片并写入配置',
    '  /link help                 本帮助',
    '',
    '工具:',
    '  link_send(device, message, timeoutSec?)  — 同上，供模型直接调用',
    '  link_status()                            — 设备清单与连通性',
    '',
    '边界:',
    '  单条确定性命令请直接用 ssh 执行（更快更省 token）；',
    '  link_send 用于需要远程 pi 自主多步处理的任务（判断/纠错/报告）',
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
