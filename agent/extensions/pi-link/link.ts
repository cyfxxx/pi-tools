import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DeviceConfig } from './config.ts'
import { parseState } from './state.ts'
import type { OutboxEntry } from './outbox.ts'

/**
 * pi-link 核心：经 SSH 通道连接远程设备的 `pi --mode rpc`，JSONL 协议收发。
 *
 * 链路：本机扩展 → spawn ssh → 远程 `pi --mode rpc [--no-extensions] [--session-dir <dir>]`
 *        → stdin/stdout 即 RPC 的 JSONL 通道（ssh exec 透传）
 * 完成判定：`agent_settled` 事件（agent 完全静默：无重试/压缩/排队后续）
 * 回复提取：最后一个 role=assistant 的 message_end，content 中 type=text 的 block 拼接
 * 会话连续性（T1-1）：远程命令先输出上次会话文件（PI_LINK_LAST_SESSION=…），
 *   本机解析后发 switch_session 复用（同一设备多次调用上下文连续）；
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
  elapsedMs?: number
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

  // T2-4 并发保护与去重（进程内）
  const key = `${device.user}@${device.host}:${device.port ?? 22}`
  const guard = checkConcurrentAndDedup(key, message)
  if (!guard.ok) {
    return { ok: false, error: guard.detail ?? '发送被拒绝', turns: 0, tools: 0, durationSec: 0, elapsedMs: Date.now() - started }
  }
  markSendStart(key, message)

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
  // switch_session 完成（response 到达）或 20s 超时
  let switchResolve: () => void
  let switchFailed = false
  const switchP = new Promise<void>((resolve) => { switchResolve = resolve })
  const switchTimer = setTimeout(() => switchResolve(), 20000)

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
      } else if (ev.type === 'response' && (ev as { id?: unknown }).id === 'pi-link-0') {
        // switch_session 响应：即使失败也继续（回退为新会话），但标记
        switchFailed = ev.success !== true
        clearTimeout(switchTimer)
        switchResolve()
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
  // 会话连续性：等远程握手行（上次会话文件）到达后发 switch_session，
  // **必须等其 response 再发 prompt**——switch 的 rebindSession 收尾与
  // 紧随的 prompt 竞争会导致 prompt 静默卡死（实测复现）。
  await handshakeP
  if (lastSession) {
    proc.stdin.write(JSON.stringify({ type: 'switch_session', sessionPath: lastSession, id: 'pi-link-0' }) + '\n')
    await switchP
    if (switchFailed) lastSession = undefined
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

  const done = (r: LinkResult): LinkResult => {
    markSendEnd(key)
    return r
  }

  if (userInteraction) {
    return done({ ok: false, reply: undefined, turns, tools, model, durationSec, error: '远程 agent 请求用户交互（ask_user/UI），无法自动应答。可在目标设备手动处理该会话。', resumed })
  }
  if (!settled && !exited) {
    return done({ ok: false, reply: text || undefined, turns, tools, model, durationSec, error: '远程会话未在超时内结束', truncated: true, resumed })
  }
  if (!text) {
    const why = stderr.trim() ? `远程 stderr: ${stderr.trim().slice(0, 300)}` : '远程未返回文本回复'
    return done({ ok: false, reply: undefined, turns, tools, model, durationSec, error: why, resumed })
  }
  return done({ ok: true, reply: text, turns, tools, model, durationSec, resumed })
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

/** 远程状态读取：ssh 执行并收集 stdout */
export function remoteExec(device: DeviceConfig, cmd: string, timeoutMs = 15000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const args = [
      ...(device.port ? ['-p', String(device.port)] : []),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      `${device.user}@${device.host}`,
      cmd,
    ]
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (c: string) => { out += c })
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (c: string) => { err += c })
    proc.on('exit', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: null, out, err }) }, timeoutMs)
  })
}

/** 读取远程状态文件（不存在→null） */
export async function readRemoteState(device: DeviceConfig): Promise<{ state: ReturnType<typeof parseState> | null; detail?: string }> {
  const r = await remoteExec(device, 'cat ~/.pi/pi-link-state.json 2>/dev/null')
  if (r.code !== 0 || !r.out.trim()) return { state: null, detail: r.err.trim().slice(0, 200) || undefined }
  const state = parseState(r.out.trim())
  return { state, detail: state ? undefined : '远程状态文件格式无效' }
}

/** 观察：远程最新会话文件尾部（--root-- TUI 会话目录或状态文件记录的会话） */
export async function watchRemote(device: DeviceConfig, lines = 30): Promise<{ ok: boolean; text: string; error?: string }> {
  // 优先状态文件记录的当前会话，否则找 --root-- 最新会话
  const { state } = await readRemoteState(device)
  const sessionFile = state?.currentSessionFile
  const cmd = sessionFile
    ? `tail -n ${lines} ${JSON.stringify(sessionFile)} 2>/dev/null || ls -t ~/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -1 | xargs -I{} tail -n ${lines} {}`
    : `F=$(ls -t ~/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -1); [ -n "$F" ] && tail -n ${lines} "$F" || echo '(无会话文件)'`
  const r = await remoteExec(device, cmd, 20000)
  if (r.code !== 0 && !r.out) return { ok: false, text: '', error: r.err.trim().slice(0, 200) || '读取失败' }
  // 会话文件是 JSONL——压缩显示（type + 关键字段）
  const rows: string[] = []
  for (const line of r.out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const ev = JSON.parse(t) as RpcEvent
      if (ev.type === 'message') {
        const m = (ev.message ?? {}) as { role?: string; content?: unknown }
        let body = ''
        if (Array.isArray(m.content)) {
          for (const b of m.content as Array<{ type?: string; text?: string; id?: string }>) {
            if (b.type === 'text' && b.text) body += b.text
            else if (b.type === 'toolCall') body += `[工具调用 ${String(b.id ?? '')}]`
          }
        } else if (typeof m.content === 'string') body = m.content
        rows.push(`${m.role === 'assistant' ? '🤖' : '👤'} ${body.slice(0, 150)}`)
      } else if (ev.type === 'turn_start') {
        rows.push('🔄 新一轮开始')
      } else if (ev.type === 'agent_settled') {
        rows.push('✅ 任务完成')
      }
    } catch {
      // 非 JSON 行忽略
    }
  }
  return { ok: true, text: rows.join('\n') || '(会话为空)' }
}

/** T2-4 并发与去重状态（模块级，进程内有效） */
const inflight = new Map<string, boolean>()
const lastSends = new Map<string, { hash: string; ts: number }>()
export const DEDUP_WINDOW_MS = 5 * 60 * 1000

/** 简单字符串 hash（djb2）——去重比对用，无需加密强度 */
export function simpleHash(s: string): string {
  const str = s ?? ''
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 并发/去重校验：同设备 in-flight 拒绝；同设备同消息窗口内拒绝 */
export function checkConcurrentAndDedup(deviceKey: string, message: string): { ok: boolean; detail?: string } {
  if (inflight.get(deviceKey)) {
    return { ok: false, detail: '该设备已有进行中的调用，请等它完成后再发' }
  }
  const hash = simpleHash(message)
  const prev = lastSends.get(deviceKey)
  if (prev && prev.hash === hash && Date.now() - prev.ts < DEDUP_WINDOW_MS) {
    const mins = Math.round((Date.now() - prev.ts) / 60000)
    return { ok: false, detail: `与 ${mins} 分钟前发送的完全相同消息，已去重（如确需重发请稍等或改动内容）` }
  }
  return { ok: true }
}

export function markSendStart(deviceKey: string, message: string): void {
  inflight.set(deviceKey, true)
  lastSends.set(deviceKey, { hash: simpleHash(message), ts: Date.now() })
}

export function markSendEnd(deviceKey: string): void {
  inflight.delete(deviceKey)
}

/** 测试辅助：清空并发/去重状态 */
export function resetSendGuards(): void {
  inflight.clear()
  lastSends.clear()
}

/** 读取远程信箱（远程 agent 自主完成的回复记录） */
export async function readRemoteOutbox(device: DeviceConfig): Promise<{ ok: boolean; entries?: OutboxEntry[]; detail?: string }> {
  const r = await remoteExec(device, 'cat ~/.pi/pi-link-outbox.json 2>/dev/null')
  if (r.code !== 0 || !r.out.trim()) {
    return { ok: false, detail: r.err.trim().slice(0, 200) || '远程信箱为空或不可读（远程需同步代码并重启 pi）' }
  }
  try {
    const d = JSON.parse(r.out.trim())
    if (!Array.isArray(d?.entries)) return { ok: false, detail: '远程信箱格式无效' }
    return { ok: true, entries: d.entries as OutboxEntry[] }
  } catch {
    return { ok: false, detail: '远程信箱格式无效' }
  }
}

/** 介入：向远程 pi 的 tmux 会话发送文本（busy 时拒绝，--force 强制） */
export async function attachToRemote(device: DeviceConfig, text: string, tmuxSession?: string, force = false): Promise<{ ok: boolean; detail: string }> {
  const { state } = await readRemoteState(device)
  const sess = tmuxSession ?? state?.tmuxSession
  if (!sess) {
    return { ok: false, detail: '无法确定远程 pi 的 tmux 会话（状态文件无 tmuxSession，且远程未运行 pi-link 扩展）' }
  }
  // 冲突防护：远程 agent 运行中（busy）时拒绝介入，防打断任务
  if (state?.status === 'busy' && !force) {
    return { ok: false, detail: `远程正在执行任务（${state.currentTask ?? '未知'}），已拒绝介入。加 --force 强制打断。` }
  }
  // tmux send-keys 不支持从 stdin 读；用 load-buffer + paste-buffer（等价粘贴）。
  // 文本经 base64 传递避免引号/特殊字符转义问题；单行消息（多行会多段粘贴）。
  const b64 = Buffer.from(text, 'utf-8').toString('base64')
  const s = JSON.stringify(sess)
  const cmd = `printf %s ${b64} | base64 -d > /tmp/pi-link-msg.txt 2>/dev/null && ` +
    `tmux load-buffer -b pi-link /tmp/pi-link-msg.txt 2>&1 && ` +
    `tmux paste-buffer -b pi-link -t ${s} 2>&1 && ` +
    `tmux send-keys -t ${s} Enter 2>&1 && rm -f /tmp/pi-link-msg.txt`
  const r = await remoteExec(device, cmd, 15000)
  if (r.code !== 0) return { ok: false, detail: r.err.trim().slice(0, 200) || `tmux send-keys 失败（exit ${r.code}）` }
  return { ok: true, detail: `已发送到远程 ${sess} 输入框` }
}
