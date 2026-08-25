import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DeviceConfig, DeviceAddr } from './config.ts'
import { deviceAddresses } from './config.ts'
import { parseState } from './state.ts'
import { selfName } from './active.ts'
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
  /** 取消信号（2026-08-25 实测：宿主 tool.execute 真实下发 AbortSignal）——
   *  触发后杀 ssh 子进程并以"已取消"返回，释放 inflight 锁 */
  signal?: AbortSignal
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

/** shell 单引号安全包裹（审计 HIGH 修复）：单引号内不做任何展开/命令替换，
 *  唯一需转义单引号本身 `'`→`'\''`。用于把配置可控值（sessionDir/cwd）拼入远端
 *  shell —— 双引号内 `$()`/反引号会命令替换造成注入，单引号不展开。
 *  值经此函数后存入 shell 变量，后续以 `"$VAR"` 引用（变量展开不二次解析命令替换）。 */
export function shellSingleQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\''`) + `'`
}

/** 构建远程命令（cwd 包装 + pi RPC 启动参数 + 会话连续性握手） */
export function buildRemoteCommand(d: DeviceConfig, opts: SendOptions): string {
  const parts = ['--mode', 'rpc']
  if (!(opts.extensions ?? d.extensions ?? false)) parts.push('--no-extensions')
  const sdir = opts.sessionDir ?? '~/.pi/agent/sessions/pi-link'
  // 审计 HIGH 修复：sdir/cwd 属配置可控值，拼接远端 shell 须经 shell 单引号包裹
  // （无展开/命令替换），并存 shell 变量后以 "$VAR" 引用阻断 `$()`/反引号类注入。
  parts.push('--session-dir', shellSingleQuote(sdir))
  const args = parts.join(' ')
  // 本机 shell 探测路径用（--session-dir 传 pi 原样解析；此处 ~ 需展开成 $HOME 才能 ls）
  const sdirAssign = sdir.startsWith('~')
    ? `$HOME${shellSingleQuote(sdir.slice(1))}`
    : shellSingleQuote(sdir)
  // 会话连续性：continue 时先找上次会话文件（非 JSON 行输出，本机解析），
  // 超过 1MB 视为旧会话（开新），fresh 策略跳过
  const policy = opts.sessionPolicy ?? d.sessionPolicy ?? 'continue'
  const resumeProbe = policy === 'fresh'
    ? ''
    : `SDIR=${sdirAssign}; ` +
      `F=$(ls -t "$SDIR"/*.jsonl 2>/dev/null | head -1); ` +
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
  // cwd 支持 ~ 开头（展开为 $HOME，文档示例 "cwd": "~/work"）；审计 HIGH 修复：
  // 经 shell 单引号包裹（~ 时拼 $HOME 前缀）存 CDIR 变量，cd "$CDIR" 引用防注入
  if (cwd) {
    const cdir = cwd.startsWith('~')
      ? `$HOME${shellSingleQuote(cwd.slice(1))}`
      : shellSingleQuote(cwd)
    cmd = `CDIR=${cdir}; cd "$CDIR" && ${cmd}`
  }
  return cmd
}

/** 单次远程调用：发 prompt，等待 agent_settled，返回最终回复 */
export async function sendToDevice(
  device: DeviceConfig,
  message: string,
  opts: SendOptions = {},
  defaultTimeoutSec?: number,
): Promise<LinkResult> {
  const started = Date.now()
  // 审计 LOW：defaultTimeoutSec（配置顶层默认）此前从未被消费——
  // 优先级：调用方显式 > 设备级 > 配置默认 > 硬编码 600
  const timeoutSec = opts.timeoutSec ?? device.timeoutSec ?? defaultTimeoutSec ?? 600

  // T2-4 并发保护与去重（进程内）
  const key = `${device.user}@${device.host}:${device.port ?? 22}`
  const guard = checkConcurrentAndDedup(key, message)
  if (!guard.ok) {
    return { ok: false, error: guard.detail ?? '发送被拒绝', turns: 0, tools: 0, durationSec: 0, elapsedMs: Date.now() - started }
  }
  markSendStart(key)
  // done 在 try 外定义：正常路径与 catch 路径共用（catch 内也要释放 in-flight 锁）
  const done = (r: LinkResult): LinkResult => {
    // 审计 MEDIUM（2026-08-25）：去重指纹仅在成功后写入——此前发送前即写，失败/超时
    // 同样占满 5 分钟窗口，重发同消息被误拒
    if (r.ok) markSendSuccess(key, message)
    markSendEnd(key)
    return r
  }
  // 审计 LOW：握手/switch 定时器在异常/提前返回路径不清空——fresh 策略无 lastSession 时
  // switchTimer 空挂 20s 拖住事件循环。声明提升到 try 外，finally 统一清理
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let switchTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // 多地址 failover：仅配置了 altHosts 时按序探测选可达地址（单地址零开销，行为与旧版一致）；
  // 全部不可达时退回主地址（让 ssh 报真实连接错误，避免误报）
  let target: DeviceAddr = { host: device.host, port: device.port }
  const addrs = deviceAddresses(device)
  if (addrs.length > 1) {
    for (const a of addrs) {
      const r = await probeAddr(device, a)
      if (r.ok) { target = a; break }
    }
  }
  const sshArgs = [
    ...(target.port ? ['-p', String(target.port)] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    ...(device.sshArgs ?? []),
    `${device.user}@${target.host}`,
    buildRemoteCommand(device, opts),
  ]

  const proc = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  const events: RpcEvent[] = []
  let settled = false
  let userInteraction = false
  let stderr = ''
  let lastSession: string | undefined
  let spawnFailed = ''
  let timedOut = false

  proc.stderr.setEncoding('utf-8')
  proc.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-2000)
  })
  // ssh 二进制缺失/PATH 清理时 spawn 抛 error——未监听会崩溃宿主 pi 进程且 inflight 泄漏
  proc.on('error', (e: Error) => {
    spawnFailed = e.message
    rl.close()
  })
  // 进程退出后写 stdin 会触发 error——吞掉
  proc.stdin.on('error', () => { /* 已退出 */ })

  // 握手完成：收到会话文件行（continue 策略）或 3s 超时
  let handshakeResolve: () => void
  const handshakeP = new Promise<void>((resolve) => { handshakeResolve = resolve })
  handshakeTimer = setTimeout(() => handshakeResolve(), 3000)
  // switch_session 完成（response 到达）或 20s 超时
  let switchResolve: () => void
  let switchFailed = false
  const switchP = new Promise<void>((resolve) => { switchResolve = resolve })
  switchTimer = setTimeout(() => switchResolve(), 20000)

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
      try {
        opts.onEvent?.(ev)
      } catch (e) {
        // onEvent 回调异常（如工具取消）不得逃逸出事件循环炸掉宿主进程，也不得阻断协议流
        console.error(`[pi-link] onEvent 回调异常: ${e instanceof Error ? e.message : String(e)}`)
      }
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

  // 进程意外退出也视为结束（rl close 会 resolve settledP）
  proc.on('exit', () => {
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

  // 超时熔断：先置标志再 kill（timedOut 判定优先于 exited，保证 truncated 分支可达）
  let cancelledBySignal = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutSec * 1000)

  // 工具取消（2026-08-25 审计 MEDIUM：宿主真实下发 AbortSignal，此前被忽略——
  // ssh 子进程跑到自然超时，期间 inflight 锁占用、同设备后续调用全被拒）
  const onAbort = () => {
    cancelledBySignal = true
    timedOut = true // 复用熔断标志优先级，保证取消分支可达
    proc.kill('SIGKILL')
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  await settledP

  clearTimeout(timer)
  if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  // 完成后关闭通道并结束进程（stdin end 触发 shutdown 是正常收尾路径）
  proc.stdin.end()
  proc.kill()

  const { text, model } = extractReply(events)
  const durationSec = Math.round((Date.now() - started) / 1000)
  const turns = events.filter((e) => e.type === 'turn_end').length
  const tools = events.filter((e) => e.type === 'tool_execution_end').length
  const resumed = lastSession !== undefined

  if (spawnFailed) {
    return done({ ok: false, reply: undefined, turns, tools, model, durationSec, error: `ssh 启动失败: ${spawnFailed}（本机 ssh 缺失？）`, resumed })
  }
  if (userInteraction) {
    return done({ ok: false, reply: undefined, turns, tools, model, durationSec, error: '远程 agent 请求用户交互（ask_user/UI），无法自动应答。可在目标设备手动处理该会话。', resumed })
  }
  if (cancelledBySignal) {
    return done({ ok: false, reply: text || undefined, turns, tools, model, durationSec, error: '调用已被取消（工具中止）', resumed })
  }
  if (timedOut) {
    return done({ ok: false, reply: text || undefined, turns, tools, model, durationSec, error: `远程会话未在 ${timeoutSec}s 超时内结束`, truncated: true, resumed })
  }
  if (!settled) {
    return done({ ok: false, reply: text || undefined, turns, tools, model, durationSec, error: '远程会话结束但未收到完成确认（agent_settled），输出可能不完整', truncated: true, resumed })
  }
  if (!text) {
    const why = stderr.trim() ? `远程 stderr: ${stderr.trim().slice(0, 300)}` : '远程未返回文本回复'
    return done({ ok: false, reply: undefined, turns, tools, model, durationSec, error: why, resumed })
  }
  return done({ ok: true, reply: text, turns, tools, model, durationSec, resumed })
  } catch (e) {
    // 任一环节异常（探测/握手/解析/onEvent）都必须释放 in-flight 锁并给出可诊断错误
    return done({
      ok: false, reply: undefined, turns: 0, tools: 0, durationSec: Math.round((Date.now() - started) / 1000),
      error: `pi-link 内部异常: ${e instanceof Error ? e.message : String(e)}`, resumed: false,
    })
  } finally {
    // 审计 LOW：settledP 完成/异常/提前 return 的所有路径统一清两个 timer
    if (handshakeTimer) clearTimeout(handshakeTimer)
    if (switchTimer) clearTimeout(switchTimer)
    markSendEnd(key)  // 幂等：正常路径 done() 已释放；异常路径兜底释放，防 in-flight 锁泄漏
  }
}

/** 连通性探测：ssh 远程执行 echo（3 秒超时） */
export function probeDevice(device: DeviceConfig): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return new Promise(async (resolve) => {
    const addrs = deviceAddresses(device)
    const started = Date.now()
    let last: { detail?: string } = {}
    for (const addr of addrs) {
      // 按序探测（主地址优先）；单地址超时 8s，多地址总耗时 = 地址数 × 单地址失败耗时
      const r = await probeAddr(device, addr)
      if (r.ok) return resolve({ ok: true, latencyMs: Date.now() - started })
      last = { detail: r.detail }
    }
    resolve({ ok: false, latencyMs: Date.now() - started, detail: last.detail })
  })
}

/** 单地址连通性探测（ssh 远程 echo，8s 兜底） */
function probeAddr(device: DeviceConfig, addr: DeviceAddr): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const args = [
      ...(addr.port ? ['-p', String(addr.port)] : []),
      // 审计 LOW：failover 探测此前不携带 device.sshArgs——依赖自定义 -i 等参数的
      // 设备探测必失败（altHosts 备选地址永不生效）；与真实发送链路对齐
      ...(device.sshArgs ?? []),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=3',
      `${device.user}@${addr.host}`,
      'echo pi-link-ok',
    ]
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let failed = ''
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (c: string) => { out += c })
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (c: string) => { err += c })
    proc.on('error', (e: Error) => {
      // spawn 失败（ssh 缺失/ENOENT）只发 error 不发 exit，必须在此 resolve 防永久挂起
      failed = e.message
      clearTimeout(t)
      resolve({ ok: false, detail: failed })
    })
    proc.on('exit', (code) => {
      clearTimeout(t)
      if (code === 0 && out.trim() === 'pi-link-ok') {
        resolve({ ok: true })
      } else {
        resolve({ ok: false, detail: failed || (err || out).trim().slice(0, 200) || `exit ${code}` })
      }
    })
    const t = setTimeout(() => {
      proc.kill('SIGKILL')
      // 兜底：spawn 失败时 kill 无效且不会产生 exit（且 error 可能早于定时器），此处直接 resolve
      resolve({ ok: false, detail: failed || 'probe timeout' })
    }, 8000)
  })
}

/** 远程状态读取：ssh 执行并收集 stdout */
export function remoteExec(device: DeviceConfig, cmd: string, timeoutMs = 15000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(async (resolve) => {
    // 多地址 failover：按序尝试，任一成功即返回；全部失败返回最后结果
    const addrs = deviceAddresses(device)
    let last: { code: number | null; out: string; err: string } = { code: null, out: '', err: '无可用地址' }
    for (const addr of addrs) {
      const r = await remoteExecAddr(device, addr, cmd, timeoutMs)
      if (r.code === 0) return resolve(r)
      last = r
    }
    resolve(last)
  })
}

/** 单地址远程执行（ssh exec，收集 stdout/stderr） */
function remoteExecAddr(device: DeviceConfig, addr: DeviceAddr, cmd: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const args = [
      ...(addr.port ? ['-p', String(addr.port)] : []),
      // 审计 MEDIUM 修复（2026-08-18）：remoteExecAddr 此前不携带 device.sshArgs——
      // probeAddr（failover 探测）与主发送链路均已带，唯此遗漏：配置自定义 -i 密钥
      // 等 sshArgs 的设备 /link watch、/link inbox、/link attach、状态读取全部静默失败
      ...(device.sshArgs ?? []),
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      `${device.user}@${addr.host}`,
      cmd,
    ]
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (c: string) => { out += c })
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (c: string) => { err += c })
    proc.on('error', (e: Error) => {
      clearTimeout(t)
      resolve({ code: null, out, err: err + e.message })
    })
    proc.on('exit', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: null, out, err }) }, timeoutMs)
  })
}

/**
 * Termux 双 home 问题：pi 扩展（proot 内）homedir()=/root，但 sshd 会话 ~=Termux home
 * （/data/data/com.termux/files/home）——远程读取必须双路径回退。
 * rel 以 .pi/ 开头（不带 ~）。
 */
const homeCat = (rel: string): string =>
  `F="$HOME/${rel}"; [ -f "$F" ] || F=/root/${rel}; cat "$F" 2>/dev/null`

/** 会话文件 glob 的双路径回退（--root-- TUI 会话目录） */
const homeGlob = (rel: string): string =>
  `(ls -t "$HOME/${rel}" 2>/dev/null || ls -t /root/${rel} 2>/dev/null) | head -1`

/** 读取远程状态文件（不存在→null） */
export async function readRemoteState(device: DeviceConfig): Promise<{ state: ReturnType<typeof parseState> | null; detail?: string }> {
  const r = await remoteExec(device, homeCat('.pi/pi-link-state.json'))
  if (r.code !== 0 || !r.out.trim()) return { state: null, detail: r.err.trim().slice(0, 200) || undefined }
  const state = parseState(r.out.trim())
  return { state, detail: state ? undefined : '远程状态文件格式无效' }
}

/** 观察：远程最新会话文件尾部（--root-- TUI 会话目录或状态文件记录的会话） */
export async function watchRemote(device: DeviceConfig, lines = 30): Promise<{ ok: boolean; text: string; error?: string }> {
  // 优先状态文件记录的当前会话，否则找 --root-- 最新会话
  const { state } = await readRemoteState(device)
  const sessionFile = state?.currentSessionFile
  const glob = `(ls -t "$HOME/.pi/agent/sessions/"*/*.jsonl 2>/dev/null || ls -t /root/.pi/agent/sessions/*/*.jsonl 2>/dev/null) | head -1`
  const cmd = sessionFile
    ? `tail -n ${lines} '${String(sessionFile).replace(/'/g, `'\''`)}' 2>/dev/null || F=$(${glob}); [ -n "$F" ] && tail -n ${lines} "$F" || echo '(无会话文件)'`
    : `F=$(${glob}); [ -n "$F" ] && tail -n ${lines} "$F" || echo '(无会话文件)'`
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
// 进程内 attach 互斥：同设备并发 attach 串行化（链式排队）——防输入框拼接/消息重复注入。
// 跨设备竞态无法用进程内锁解决（不同主机），由唯一 buffer 名 + 原子探测粘贴最小化。
const attachLocks = new Map<string, Promise<unknown>>()
async function withAttachLock<T>(deviceKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = attachLocks.get(deviceKey) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  run.catch(() => {}) // 防未处理 rejection
  attachLocks.set(deviceKey, run)
  try {
    return await run
  } finally {
    if (attachLocks.get(deviceKey) === run) attachLocks.delete(deviceKey)
  }
}
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

export function markSendStart(deviceKey: string): void {
  inflight.set(deviceKey, true)
}
/** 发送成功后写去重指纹（审计 MEDIUM：失败/超时不写，避免误拒重发） */
export function markSendSuccess(deviceKey: string, message: string): void {
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
  const r = await remoteExec(device, homeCat('.pi/pi-link-outbox.json'))
  if (r.code !== 0 || !r.out.trim()) {
    return { ok: false, detail: r.err.trim().slice(0, 200) || '远程信箱为空或不可读（远程需同步代码并重启 pi）' }
  }
  try {
    const d = JSON.parse(r.out.trim())
    if (!Array.isArray(d?.entries)) return { ok: false, detail: '远程信箱格式无效' }
    // 校验元素结构（坏文件/恶意内容防御：/link inbox 展示前过滤）
    const entries = (d.entries as unknown[])
      .filter((e): e is OutboxEntry => !!e && typeof e === 'object'
        && typeof (e as OutboxEntry).text === 'string' && typeof (e as OutboxEntry).ts === 'number')
      .slice(-10)
    return { ok: true, entries }
  } catch {
    return { ok: false, detail: '远程信箱格式无效' }
  }
}

/** 介入：向远程 pi 的 tmux 会话发送文本（busy 时拒绝，--force 强制） */
/** 介入：向远程 pi 的 tmux 会话发送文本（busy 时拒绝，--force 强制）。
 * fromName：发送者身份名（默认本机 selfName）——消息自动加身份前缀，
 * 远程用户看到消息即知来自哪台设备。 */
export async function attachToRemote(device: DeviceConfig, text: string, tmuxSession?: string, force = false, fromName?: string): Promise<{ ok: boolean; detail: string }> {
  const dk = `${device.user}@${device.host}:${device.port ?? 22}`
  return withAttachLock(dk, () => attachToRemoteInner(device, text, tmuxSession, force, fromName))
}

async function attachToRemoteInner(device: DeviceConfig, text: string, tmuxSession?: string, force = false, fromName?: string): Promise<{ ok: boolean; detail: string }> {
  const { state } = await readRemoteState(device)
  // 身份前缀：默认开启（接收方可辨识发送设备）；已含 [来自 前缀的消息不重复加
  if (!/^\[来自 .+\]/.test(text)) {
    const who = fromName || selfName()
    text = `[来自 ${who}] ${text}`
  }
  const sess = tmuxSession ?? state?.tmuxSession
  if (!sess) {
    return { ok: false, detail: '无法确定远程 pi 的 tmux 会话（状态文件无 tmuxSession，且远程未运行 pi-link 扩展）' }
  }
  // 冲突防护：远程 agent 运行中（busy）时拒绝介入，防打断任务
  if (state?.status === 'busy' && !force) {
    return { ok: false, detail: `远程正在执行任务（${state.currentTask ?? '未知'}），已拒绝介入。加 --force 强制打断。` }
  }
  // 远程 state 文件可控字段——shell 注入防护：单引号转义（防 $()/反引号/分号/空格断参）
  const s = `'${String(sess).replace(/'/g, `'\''`)}'`

  // tmux send-keys 不支持从 stdin 读；用 load-buffer + paste-buffer（等价粘贴）。
  // 文本经 base64 传递避免引号/特殊字符转义问题；单行消息（多行会多段粘贴）。
  const b64 = Buffer.from(text, 'utf-8').toString('base64')

  // 原子发送：探测输入框 + 粘贴 + 回车在同一条远程命令内完成（同一 shell 会话，
  // 探测与粘贴之间毫秒级，杜绝'探测后用户输入被拼接'的竞态窗口）。
  // 远程判定：tail -3 中非空、非~、非分隔线、非状态栏的行 = 输入框有内容 → exit 3。
  // pi TUI 布局：底部状态栏（含模型名/•/token），其上为输入框（空时显示 ~ 或空白）。
  const busyMark = 'PI_LINK_INPUT_BUSY'
  const tryPaste = async (enter: boolean): Promise<'sent' | 'busy' | 'failed'> => {
    // 中间文件放 $HOME（Termux 原始环境 /tmp 不可写，proot 环境 /tmp 可用——$HOME 两环境都稳）；
    // 文件名带随机后缀：并发/跨设备 attach 的中间文件互不覆盖（与 buffer 名同源策略）
    const tmp = `$HOME/.pi-link-msg.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // PRoot 兼容：Termux sshd 会话的 LD_PRELOAD(libtermux-exec) 会破坏 proot 内 Ubuntu tmux 的
    // 动态加载（"required file not found"）；探测裸 tmux，失败回退显式解释器+清 LD_PRELOAD。
    // 注意：LD_PRELOAD= 赋值必须写在函数体内（变量展开的词首不触发赋值，实测 "command not found"）
    const tmuxProbe = `TMUX_FB=0; tmux_cmd() { if [ "$TMUX_FB" = 1 ]; then LD_PRELOAD= /lib/ld-linux-aarch64.so.1 /usr/bin/tmux "\$@"; else tmux "\$@"; fi; }; ` +
      `if ! tmux ls >/dev/null 2>&1; then ` +
      `if LD_PRELOAD= /lib/ld-linux-aarch64.so.1 /usr/bin/tmux ls >/dev/null 2>&1; then TMUX_FB=1; else TMUX_FB=2; fi; fi; ` +
      `[ "$TMUX_FB" != 2 ] || exit 4; `
    // buffer 名唯一（时间戳+随机）：并发/跨设备 attach 不互相覆盖 tmux buffer
    const buf = 'pi-link-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const paste = `${tmuxProbe}` +
      `printf %s ${b64} | base64 -d > ${tmp} 2>/dev/null && ` +
      `tmux_cmd load-buffer -b ${buf} ${tmp} 2>&1 && ` +
      `tmux_cmd paste-buffer -b ${buf} -t ${s} 2>&1 && ` +
      (enter ? `sleep 0.5 && tmux_cmd send-keys -t ${s} Enter 2>&1 && ` : '') +
      `rm -f ${tmp}` +
      // 审计 LOW：&& 链中断（load-buffer/paste 失败）时 rm 不执行，远程临时文件
      // 残留——分号无条件兜底清理（幂等）
      `; rm -f ${tmp} 2>/dev/null`
    const probe = `${tmuxProbe}` +
      `P=$(tmux_cmd display-message -p -t ${s} '#{cursor_y}' 2>/dev/null); ` +
      `[ -z "$P" ] && P=$(tmux_cmd capture-pane -p -t ${s} 2>/dev/null | wc -l); ` +
      `L=$(tmux_cmd capture-pane -p -t ${s} 2>/dev/null | sed -n "$((P+1))p" | tr -d '\x1b' | sed 's/\r$//'); ` +
      `T=$(printf '%s' "$L" | tr -d '[:space:]'); ` +
      `if [ -n "$T" ] && [ "$T" != "~" ]; then echo '${busyMark}'; exit 3; fi; ` +
      paste
    const r = await remoteExec(device, probe, 15000)
    if (r.out.includes(busyMark)) return 'busy'
    if (r.code !== 0) return 'failed'
    return 'sent'
  }

  const first = await tryPaste(true)
  if (first === 'sent') return { ok: true, detail: `已发送到远程 ${sess} 输入框并回车` }
  if (first === 'failed') {
    return { ok: false, detail: 'tmux 操作失败（远程命令异常退出）' }
  }
  // 输入框有内容（有人在输入）——轮询等清空（最长 60s），清空后只粘贴不回车，由用户回车
  // 审计 LOW：原 waited 只累计 sleep 2s，tryPaste 的 remoteExec（15s 超时）不计入——
  // 实际等待可达 ~8 分钟；改为墙钟计时
  const attachDeadline = Date.now() + 60000
  while (Date.now() < attachDeadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const again = await tryPaste(false)
    if (again === 'sent') return { ok: true, detail: `已粘贴到远程 ${sess} 输入框（输入框曾被占用，请远程用户回车发送）` }
    if (again === 'failed') return { ok: false, detail: 'tmux 操作失败（远程命令异常退出）' }
  }
  return { ok: false, detail: '远程输入框持续有内容（可能正在输入），未发送。可稍后再试。' }
}
