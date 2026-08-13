import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DeviceConfig } from './config'

/**
 * pi-link 核心：经 SSH 通道连接远程设备的 `pi --mode rpc`，JSONL 协议收发。
 *
 * 链路：本机扩展 → spawn ssh → 远程 `pi --mode rpc [--no-extensions] [--session-dir <dir>]`
 *        → stdin/stdout 即 RPC 的 JSONL 通道（ssh exec 透传）
 * 完成判定：`agent_settled` 事件（agent 完全静默：无重试/压缩/排队后续）
 * 回复提取：最后一个 role=assistant 的 message_end，content 中 type=text 的 block 拼接
 * 会话连续性（T1-1）：远程命令先输出上次会话文件（PI_LINK_LAST_SESSION=…），
 *   本机解析后发 load_session 复用（同一设备多次调用上下文连续）；
 *   会话文件超过 1MB 自动开新会话（防无限增长）。
 * 流式回传（T1-2）：onEvent 回调把远程事件实时转发给上层（工具进度可见）。
 * 指令模板（T1-3）：消息加远程执行指令前缀，避免措辞歧义。
 */

export interface LinkResult {
  ok: boolean
  reply?: string
  turns: number
  tools: number
  model?: string
  durationSec: number
  error?: string
  truncated?: boolean
  resumed?: boolean
}

interface RpcEvent {
  type: string
  [k: string]: unknown
}

export interface SendOptions {
  timeoutSec?: number
  extensions?: boolean
  sessionDir?: string
  cwd?: string
  sshArgs?: string[]
  /** 会话策略：continue=复用上次会话（默认），fresh=每次新会话 */
  sessionPolicy?: 'continue' | 'fresh'
  /** 流式回调：每个远程事件实时转发（上层可显示进度） */
  onEvent?: (ev: RpcEvent) => void
  /** 任务消息模板（T1-3）：默认注入远程执行指令前缀 */
  wrapTask?: boolean
  /** 发起设备名（指令模板标注） */
  fromName?: string
}

/** 会话文件大小上限（超过则开新会话，防无限增长） */
const MAX_SESSION_BYTES = 1024 * 1024

/** T1-3 远程执行指令模板：消除"回复 XX"被远程误解为聊天行为的歧义 */
export function wrapTaskMessage(message: string, fromName?: string): string {
  const from = fromName ? `（发起设备: ${fromName}）` : ''
  return [
    '[远程执行任务] 你正在远程设备上作为执行代理处理来自本机 pi 的任务指令' + from + '。',
    '规则：',
    '1. 直接执行任务并完成任务本身，回复中输出任务结果/结论',
    '2. 不要询问"回复给谁/通过什么通道"——你的回复会自动回传给发起方',
    '3. 不要寒暄、不要提及本提示',
    '',
    '任务指令：',
    message,
  ].join('\n')
}

/** 提取 assistant 最终文本：取最后一个 assistant message_end 的 text blocks */
export function extractReply(events: RpcEvent[]): { text: string; model?: string } {
  let text = ''
  let model: string | undefined
  for (const ev of events) {
    if (ev.type !== 'message_end') continue
    const m = (ev.message ?? {}) as { role?: string; content?: unknown; model?: string }
    if (m.role !== 'assistant') continue
    model = m.model ?? model
    if (Array.isArray(m.content)) {
      const parts: string[] = []
      for (const b of m.content as Array<{ type?: string; text?: string }>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text) parts.push(b.text)
      }
      if (parts.length) text = parts.join('\n')
    } else if (typeof m.content === 'string' && m.content) {
      text = m.content
    }
  }
  return { text, model }
}

/** 构建远程命令（cwd 包装 + pi RPC 启动参数 + 会话连续性握手） */
export function buildRemoteCommand(d: DeviceConfig, opts: SendOptions): string {
  const parts = ['--mode', 'rpc']
  if (!(opts.extensions ?? d.extensions ?? false)) parts.push('--no-extensions')
  const sdir = opts.sessionDir ?? '~/.pi/agent/sessions/pi-link'
  parts.push('--session-dir', sdir)
  const args = parts.join(' ')
  // 会话连续性：continue 时先找上次会话文件（非 JSON 行输出，本机解析），
  // 超过 1MB 视为旧会话（开新），fresh 策略跳过
  const policy = opts.sessionPolicy ?? d.sessionPolicy ?? 'continue'
  const resumeProbe = policy === 'fresh'
    ? ''
    : `F=$(ls -t "${sdir}"/*.jsonl 2>/dev/null | head -1); ` +
      `if [ -n "$F" ]; then SZ=$(stat -c%s "$F" 2>/dev/null || stat -f%z "$F" 2>/dev/null || echo 1048577); ` +
      `if [ "$SZ" -lt 1048576 ]; then echo "PI_LINK_LAST_SESSION=$F"; fi; fi; `
  // 远程启动路径：优先 node + 真实 cli.js（绕过 pi-wrapper 的启动开销，
  // 避免 RPC 就绪前就把超时窗口耗尽）。非交互 ssh 会话 PATH 常缺 pi/node，
  // 用 command -v 探测 + 常见绝对路径兑底（pi-node 安装布局）。
  const launch = `JS=$(readlink -f "$(command -v pi-original 2>/dev/null || command -v pi 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/pi-original")" 2>/dev/null); ` +
    `NODE_BIN="$(command -v node 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/node")"; ` +
    `[ -f "$JS" ] && [ -f "$NODE_BIN" ] && exec "$NODE_BIN" "$JS" ${args}; ` +
    `exec pi ${args}`
  let cmd = resumeProbe + launch
  const cwd = opts.cwd ?? d.cwd
  // Termux sshd 会话带 libtermux-exec LD_PRELOAD，会破坏 proot 内 node 加载——清除
  cmd = `unset LD_PRELOAD 2>/dev/null; ${cmd}`
  if (cwd) cmd = `cd ${JSON.stringify(cwd)} && ${cmd}`
  return cmd
}

/** 单次远程调用：发 prompt，等待 agent_settled，返回最终回复 */
export async function sendToDevice(
  device: DeviceConfig,
  message: string,
  opts: SendOptions = {},
): Promise<LinkResult> {
  const started = Date.now()
  const timeoutSec = opts.timeoutSec ?? device.timeoutSec ?? 600

  const sshArgs = [
    ...(device.port ? ['-p', String(device.port)] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...(device.sshArgs ?? []),
    `${device.user}@${device.host}`,
    buildRemoteCommand(device, opts),
  ]

  const proc = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  const events: RpcEvent[] = []
  let settled = false
  let userInteraction = false
  let stderr = ''
  let lastSession: string | undefined

  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-2000)
  })

  // 握手完成：收到会话文件行（continue 策略）或 3s 超时
  let handshakeResolve: () => void
  const handshakeP = new Promise<void>((resolve) => { handshakeResolve = resolve })
  const handshakeTimer = setTimeout(() => handshakeResolve(), 3000)

  const rl = createInterface({ input: proc.stdout })
  const settledP = new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      let ev: RpcEvent
      try {
        ev = JSON.parse(line) as RpcEvent
      } catch {
        // 非 JSON 行：识别会话连续性握手标记
        const m = /^PI_LINK_LAST_SESSION=(.+)$/.exec(line.trim())
        if (m) {
          lastSession = m[1]
          clearTimeout(handshakeTimer)
          handshakeResolve()
        }
        return
      }
      events.push(ev)
      opts.onEvent?.(ev)
      if (ev.type === 'agent_settled') {
        settled = true
        resolve()
      } else if (ev.type === 'extension_ui_request') {
        // 远程 agent 请求用户交互（ask_user / UI 子协议）——无法自动处理
        userInteraction = true
      }
    })
    rl.on('close', () => resolve())
  })

  // 进程意外退出也视为结束
  let exited = false
  proc.on('exit', () => {
    exited = true
    rl.close()
  })

  // 指令模板（T1-3）：默认包裹远程执行指令
  const finalMessage = (opts.wrapTask ?? true) ? wrapTaskMessage(message, opts.fromName) : message

  // ⚠ 不能 close/end stdin：RPC 模式将 stdin end 视为客户端断开，
  // 触发 shutdown 中断 agent 运行（曾导致 LLM 请求刚发出就被静默终止）。
  // 会话连续性：等远程握手行（上次会话文件）到达后再写命令——
  // 远程 shell 先 echo 握手行再 exec RPC；3s 超时兜底（无会话则直接 prompt）。
  await handshakeP
  if (lastSession) {
    // RPC 命令名是 switch_session（load_session 不存在，曾导致会话连续性静默失效）
    proc.stdin.write(JSON.stringify({ type: 'switch_session', sessionPath: lastSession, id: 'pi-link-0' }) + '\n')
  }
  const prompt = JSON.stringify({ type: 'prompt', message: finalMessage, id: 'pi-link-1' })
  proc.stdin.write(prompt + '\n')
  // Writable 无需显式 flush（数据即时发送）

  // 超时熔断
  const timer = setTimeout(() => {
    proc.kill('SIGKILL')
  }, timeoutSec * 1000)

  await settledP

  clearTimeout(timer)
  // 完成后关闭通道并结束进程（stdin end 触发 shutdown 是正常收尾路径）
  proc.stdin.end()
  proc.kill()

  const { text, model } = extractReply(events)
  const durationSec = Math.round((Date.now() - started) / 1000)
  const turns = events.filter((e) => e.type === 'turn_end').length
  const tools = events.filter((e) => e.type === 'tool_execution_end').length
  const resumed = lastSession !== undefined

  if (userInteraction) {
    return { ok: false, reply: undefined, turns, tools, model, durationSec, error: '远程 agent 请求用户交互（ask_user/UI），无法自动应答。可在目标设备手动处理该会话。', resumed }
  }
  if (!settled && !exited) {
    return { ok: false, reply: text || undefined, turns, tools, model, durationSec, error: '远程会话未在超时内结束', truncated: true, resumed }
  }
  if (!text) {
    const why = stderr.trim() ? `远程 stderr: ${stderr.trim().slice(0, 300)}` : '远程未返回文本回复'
    return { ok: false, reply: undefined, turns, tools, model, durationSec, error: why, resumed }
  }
  return { ok: true, reply: text, turns, tools, model, durationSec, resumed }
}

/** 连通性探测：ssh 远程执行 echo（3 秒超时） */
export function probeDevice(device: DeviceConfig): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const args = [
      ...(device.port ? ['-p', String(device.port)] : []),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=3',
      `${device.user}@${device.host}`,
      'echo pi-link-ok',
    ]
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (c: string) => { out += c })
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (c: string) => { err += c })
    proc.on('exit', (code) => {
      const latencyMs = Date.now() - started
      if (code === 0 && out.trim() === 'pi-link-ok') {
        resolve({ ok: true, latencyMs })
      } else {
        resolve({ ok: false, latencyMs, detail: (err || out).trim().slice(0, 200) || `exit ${code}` })
      }
    })
    const t = setTimeout(() => { proc.kill('SIGKILL') }, 8000)
    proc.on('exit', () => clearTimeout(t))
  })
}
