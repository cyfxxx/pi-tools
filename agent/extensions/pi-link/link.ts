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

/** 构建远程命令（cwd 包装 + pi RPC 启动参数） */
export function buildRemoteCommand(d: DeviceConfig, opts: SendOptions): string {
  const parts = ['--mode', 'rpc']
  if (!(opts.extensions ?? d.extensions ?? false)) parts.push('--no-extensions')
  const sdir = opts.sessionDir ?? '~/.pi/agent/sessions/pi-link'
  parts.push('--session-dir', sdir)
  const args = parts.join(' ')
  // 远程启动路径：优先 node + 真实 cli.js（绕过 pi-wrapper 的启动开销，
  // 避免 RPC 就绪前就把超时窗口耗尽）。非交互 ssh 会话 PATH 常缺 pi/node，
  // 用 command -v 探测 + 常见绝对路径兑底（pi-node 安装布局）。
  const launch = `JS=$(readlink -f "$(command -v pi-original 2>/dev/null || command -v pi 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/pi-original")" 2>/dev/null); ` +
    `NODE_BIN="$(command -v node 2>/dev/null || echo "$HOME/.local/share/pi-node/current/bin/node")"; ` +
    `[ -f "$JS" ] && [ -f "$NODE_BIN" ] && exec "$NODE_BIN" "$JS" ${args}; ` +
    `exec pi ${args}`
  let cmd = launch
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

  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-2000)
  })

  const rl = createInterface({ input: proc.stdout })
  const settledP = new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      let ev: RpcEvent
      try {
        ev = JSON.parse(line) as RpcEvent
      } catch {
        return // 非 JSON 行（ssh banner 等）忽略
      }
      events.push(ev)
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

  // 等待 RPC 就绪（启动期 stdout 会有 session/model 事件，无需显式握手：
  // 直接写入 prompt 后 RPC 会排队处理；若进程早退则 readline close 兜底）
  // ⚠ 不能 close/end stdin：RPC 模式将 stdin end 视为客户端断开，
  // 触发 shutdown 中断 agent 运行（曾导致 LLM 请求刚发出就被静默终止）。
  const prompt = JSON.stringify({ type: 'prompt', message, id: 'pi-link-1' })
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

  if (userInteraction) {
    return { ok: false, reply: undefined, turns, tools, model, durationSec, error: '远程 agent 请求用户交互（ask_user/UI），无法自动应答。可在目标设备手动处理该会话。' }
  }
  if (!settled && !exited) {
    return { ok: false, reply: text || undefined, turns, tools, model, durationSec, error: '远程会话未在超时内结束', truncated: true }
  }
  if (!text) {
    const why = stderr.trim() ? `远程 stderr: ${stderr.trim().slice(0, 300)}` : '远程未返回文本回复'
    return { ok: false, reply: undefined, turns, tools, model, durationSec, error: why }
  }
  return { ok: true, reply: text, turns, tools, model, durationSec }
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
