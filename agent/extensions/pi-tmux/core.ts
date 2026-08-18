/**
 * pi-tmux core — tmux 会话管理逻辑。
 * 纯模块，不依赖 @earendil-works/pi-coding-agent，便于 vitest 独立测试。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, readSync, writeSync, closeSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'

export const SESSION_PREFIX = 'pi-'
const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/
export const TMUX_LOG_DIR_REL = join('logs', 'tmux')

export interface TmuxOpts {
  bin: string
  logDir: string
  prefix: string
}

export interface TmuxRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 执行 tmux 命令（argv 数组，无 shell 注入）。超时强制结束。 */
export function runTmux(opts: TmuxOpts, args: string[], timeoutMs = 15000): Promise<TmuxRunResult> {
  if (process.platform === 'win32') return runTmuxWindows(opts, args)
  return new Promise((resolvePromise) => {
    const child = execFile(opts.bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      const code = (err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string }).code
      if (typeof code === 'number') {
        resolvePromise({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      if (err.message.includes('ENOENT')) {
        resolvePromise({ code: 127, stdout: '', stderr: `tmux: command not found (${opts.bin})` })
        return
      }
      // Node v22 超时杀进程时 err.code=null、signal='SIGTERM'、killed=true，
      // message 不含 ETIMEDOUT——按 killed 判定超时（审计 LOW：e.signal==='SIGTERM'
      // 会把外部 SIGTERM 正常终止的进程也误报 timeout；killed 仅超时自杀时置 true）
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
      if (e.killed === true) {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `tmux timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? err.message })
    })
  })
}

// ============================================================================
// Windows 原生后端：无 tmux——Node spawn 交互 shell + stdin 管道 + 日志文件 + pid 管理
// 模拟 tmux CLI 语义（new-session/list-sessions/has-session/send-keys/capture-pane/kill-session）
// ============================================================================

/** 本进程内会话句柄（stdin 写入需要 child 引用；进程退出自动清理） */
const winChildren = new Map<string, import('node:child_process').ChildProcess>()
/** bash -c 启动的会话（无 stdin 交互——send-keys 文本写入静默积压，仅 Ctrl-C/读取/停止可用） */
const winNonInteractive = new Set<string>()

function winPidPath(opts: TmuxOpts, name: string): string {
  return join(opts.logDir, `${name}.pid`)
}

/** 解析 args 中 -flag 的值（tmux 参数风格） */
function winArgAt(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** 会话名：优先 Map → pidfile → 空。NAME_RE 校验（防路径穿越：../../x 等非法名返回空——调用点自然失败，不会进入 pidfile/taskkill/文件读写） */
function winSessionName(opts: TmuxOpts, args: string[]): string {
  const n = winArgAt(args, '-t') ?? winArgAt(args, '-s') ?? ''
  return n && NAME_RE.test(n) ? n : ''
}

/** 便携包 shell：PortableGit bash（优先）→ 系统 cmd.exe */
function resolveWindowsShell(): string {
  const root = process.env.USERPROFILE || homedir()
  const bash = join(root, 'tools', 'PortableGit', 'usr', 'bin', 'bash.exe').replace(/\\/g, '/')
  return existsSync(bash) ? bash : 'cmd.exe'
}

function winPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function winReadPid(opts: TmuxOpts, name: string): number | undefined {
  const p = winPidPath(opts, name)
  try {
    const pid = Number.parseInt(readFileSync(p, 'utf-8').trim(), 10)
    return Number.isFinite(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function winWritePid(opts: TmuxOpts, name: string, pid: number): void {
  ensureLogDir(opts)
  try { writeFileSync(winPidPath(opts, name), String(pid), 'utf-8') } catch { /* ignore */ }
}

function winRemovePid(opts: TmuxOpts, name: string): void {
  try { rmSync(winPidPath(opts, name)) } catch { /* ignore */ }
}

/** taskkill 树杀（子进程命令一并终止） */
function winTaskkill(pid: number): Promise<TmuxRunResult> {
  return new Promise((resolvePromise) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      if (!err) resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      else resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? err.message })
    })
  })
}

function winReadLogTail(opts: TmuxOpts, name: string, lines: number): string {
  const logPath = logPathFor(opts, name)
  try {
    if (!existsSync(logPath)) return ''
    const content = readFileSync(logPath, 'utf-8')
    return content.split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/** Windows 后端主入口：解析 tmux 命令语义并分发 */
async function runTmuxWindows(opts: TmuxOpts, args: string[]): Promise<TmuxRunResult> {
  const cmd = args[0]
  if (!cmd) return { code: 1, stdout: '', stderr: 'empty tmux command' }

  // tmux -V：版本检查（扩展启动时探测）——伪报版本以通过探测
  if (cmd === '-V' || cmd === '--version') {
    return { code: 0, stdout: 'tmux 3.4 (portable-windows)', stderr: '' }
  }

  // new-session -d -s NAME -c CWD → spawn 交互 shell + 日志 fd + pid
  if (cmd === 'new-session') {
    const name = winArgAt(args, '-s')
    // 审计 LOW：纵深防御——其他子命令均经 winSessionName 的 NAME_RE 校验
    // （防 pidfile/log 路径穿越），new-session 补同款校验
    if (!name || !NAME_RE.test(name)) return { code: 1, stdout: '', stderr: 'new-session: invalid session name' }
    // 已存在且存活 → duplicate（与 tmux 语义一致）
    if (winChildren.has(name) || winPidAlive(winReadPid(opts, name))) {
      return { code: 1, stdout: '', stderr: `duplicate session: ${name}` }
    }
    const cwd = (winArgAt(args, '-c') || homedir()).replace(/\\/g, '/')
    // 末尾位置参数 = 启动命令（tmux 语义：new-session -d -s N -c CWD 'command'）
    // 审计 LOW：原实现丢弃 '-' 开头参数（'ls -la' 的命令参数被删）且只取最后
    // 一个位置参数（多词命令丢参）——收集剩余参数 join 保留完整命令
    let launchArgs: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (['-d', '-s', '-c'].includes(a)) { i++; continue }
      launchArgs.push(a)
    }
    const launchCmd = launchArgs.join(' ')
    const shell = resolveWindowsShell()
    const logPath = logPathFor(opts, name)
    ensureLogDir(opts)
    // 日志 fd 由 Node 侧写入（spawn stdio 用 Node 管道——文件 fd 全缓冲导致输出积压不落盘）
    let logFd: number
    try {
      logFd = openSync(logPath, 'a')
    } catch (e) {
      return { code: 1, stdout: '', stderr: `open log failed: ${String(e)}` }
    }
    let child: import('node:child_process').ChildProcess
    const isCmd = shell.toLowerCase().endsWith('cmd.exe')
    // cmd.exe 兜底：bash 风格参数不适用（cmd 静默忽略 → 空提示符）；用 /d /s /c
    const shellArgs = isCmd
      ? launchCmd
        ? ['/d', '/s', '/c', launchCmd]
        : ['/d', '/k']
      : launchCmd
        ? ['--noprofile', '--norc', '-c', launchCmd]
        : ['--noprofile', '--norc', '-i']
    if (launchCmd) winNonInteractive.add(name)
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      closeSync(logFd)
      return { code: 1, stdout: '', stderr: `spawn shell failed: ${String(e)}` }
    }
    child.stdout.on('data', (d) => { try { writeSync(logFd, d) } catch { /* ignore */ } })
    child.stderr.on('data', (d) => { try { writeSync(logFd, d) } catch { /* ignore */ } })
    // spawn 异步 error（cwd 不存在/权限）→ 清理 Map/pidfile/日志 fd（exit 事件不触发）
    child.on('error', (e) => {
      console.error('[pi-tmux-win] spawn error:', e.message)
      winChildren.delete(name)
      winNonInteractive.delete(name)
      winRemovePid(opts, name)
      try { closeSync(logFd) } catch { /* ignore */ }
    })
    child.unref()
    winChildren.set(name, child)
    winWritePid(opts, name, child.pid ?? 0)
    child.on('exit', () => {
      winChildren.delete(name)
      winNonInteractive.delete(name)
      winRemovePid(opts, name)
      try { closeSync(logFd) } catch { /* ignore */ }
    })
    return { code: 0, stdout: '', stderr: '' }
  }

  // pipe-pane：日志已由 spawn stdio 重定向，no-op
  if (cmd === 'pipe-pane') return { code: 0, stdout: '', stderr: '' }

  // send-keys -t NAME [-l TEXT] [Enter] [C-x]
  if (cmd === 'send-keys') {
    const name = winSessionName(opts, args)
    if (!name) return { code: 1, stdout: '', stderr: "send-keys: 非法会话名" }
    const child = winChildren.get(name)
    if (!child || child.stdin.destroyed || winNonInteractive.has(name)) {
      // bash -c 会话（无 stdin 交互——标记拦截，不静默积压）或跨重启：Ctrl-C 可 taskkill，其余不支持
      if (args.includes('C-c')) {
        const pid = winReadPid(opts, name)
        if (pid && winPidAlive(pid)) return winTaskkill(pid)
      }
      return { code: 1, stdout: '', stderr: `send-keys: session ${name} 无 stdin 交互（bash -c 启动或已重启）——仅支持 Ctrl-C/读取/停止` }
    }
    const li = args.indexOf('-l')
    if (li >= 0) child.stdin.write(args[li + 1] ?? '')
    if (args.includes('Enter')) child.stdin.write('\n')
    if (args.includes('C-c')) {
      const pid = winReadPid(opts, name)
      if (pid && winPidAlive(pid)) return winTaskkill(pid)
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  // list-sessions -F ...
  if (cmd === 'list-sessions') {
    const names = new Set<string>([...winChildren.keys()])
    // 审计 MEDIUM 修复：全新环境（从未创建会话）logDir 不存在 → readdirSync
    // 抛 ENOENT 致首次 tmux_status 必失败；缺失目录按空列表处理
    try {
      for (const f of readdirSync(opts.logDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.pid')) {
          const n = f.name.slice(0, -4)
          if (winPidAlive(winReadPid(opts, n))) names.add(n)
        }
      }
    } catch {
      /* logDir 不存在/不可读：仅返回进程内会话 */
    }
    const out = [...names].map((n) => `${n}\t0`).join('\n')
    return { code: 0, stdout: out, stderr: '' }
  }

  // has-session -t NAME
  if (cmd === 'has-session') {
    const name = winSessionName(opts, args)
    if (!name) return { code: 1, stdout: '', stderr: "can't find session: (非法会话名)" }
    const alive = winChildren.has(name) || winPidAlive(winReadPid(opts, name))
    return alive
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: `can't find session: ${name}` }
  }

  // capture-pane -t NAME -p -S -N
  if (cmd === 'capture-pane') {
    const name = winSessionName(opts, args)
    const sIdx = args.indexOf('-S')
    const lines = Math.abs(sIdx >= 0 ? Number.parseInt(args[sIdx + 1] ?? '100', 10) || 100 : 100)
    return { code: 0, stdout: winReadLogTail(opts, name, lines), stderr: '' }
  }

  // kill-session -t NAME
  if (cmd === 'kill-session') {
    const name = winSessionName(opts, args)
    if (!name) return { code: 1, stdout: '', stderr: "can't find session: (非法会话名)" }
    const child = winChildren.get(name)
    const pid = winReadPid(opts, name)
    if (child) {
      winChildren.delete(name)
      try { child.kill() } catch { /* ignore */ }
    }
    winRemovePid(opts, name)
    if (pid && winPidAlive(pid)) return winTaskkill(pid)
    return { code: 0, stdout: '', stderr: '' }
  }

  return { code: 1, stdout: '', stderr: `tmux 命令 ${cmd} 在 Windows 后端不支持` }
}

export function defaultOpts(): TmuxOpts {
  const piHome = process.env.PI_HOME || join(homedir(), '.pi')
  return { bin: 'tmux', logDir: join(piHome, TMUX_LOG_DIR_REL), prefix: SESSION_PREFIX }
}

/** 生成可安装指引的错误信息，供模型直接修复环境。 */
export function tmuxMissingError(detail: string): string {
  return (
    `tmux 不可用：${detail}\n\n` +
    '请安装 tmux 后重试。按系统选择：\n' +
    '  Debian/Ubuntu:  sudo apt-get install -y tmux\n' +
    '  Fedora/RHEL:    sudo dnf install -y tmux\n' +
    '  Arch:           sudo pacman -S tmux\n' +
    '  openSUSE:       sudo zypper install tmux\n' +
    '  macOS (brew):   brew install tmux\n' +
    '安装完成后验证：tmux -V\n' +
    '更多问题排查：~/.pi/docs/alacritty-tmux-setup.md'
  )
}

export function tmuxUnsupportedError(detail: string): string {
  return (
    `tmux 当前不可用：${detail}\n\n` +
    '可能原因：当前不在 tmux server 可访问环境（如容器/CI/无 $TMUX 上下文）。' +
    '可通过 pi-tmux 扩展工具创建 detached 会话（tmux new-session -d 不依赖 $TMUX），' +
    '若仍失败请先安装并启动 tmux server：tmux new-session -d -s bootstrap'
  )
}

/** 校验并规范化会话名：强制 pi- 前缀，仅允许字母数字下划线中划线。 */
export function normalizeSessionName(raw: string, prefix = SESSION_PREFIX): string {
  let name = (raw || '').trim()
  if (!name) throw new Error('会话名为空')
  if (name.startsWith(prefix)) name = name.slice(prefix.length)
  if (!NAME_RE.test(name)) {
    throw new Error(`非法会话名 "${raw}"：仅允许字母/数字/下划线/中划线，长度 1-40`)
  }
  return prefix + name
}

export function isPiSession(name: string, prefix = SESSION_PREFIX): boolean {
  return name.startsWith(prefix)
}

export function ensureLogDir(opts: TmuxOpts): string {
  mkdirSync(opts.logDir, { recursive: true })
  return opts.logDir
}

export function logPathFor(opts: TmuxOpts, name: string): string {
  return join(opts.logDir, `${name}.log`)
}

/** 会话名 → 是否当前存在 */
export async function hasSession(opts: TmuxOpts, name: string): Promise<boolean> {
  const r = await runTmux(opts, ['has-session', '-t', name])
  return r.code === 0
}

export interface SessionInfo {
  name: string
  attached: boolean
}

/** 列出所有 tmux 会话 */
export async function listSessions(opts: TmuxOpts): Promise<SessionInfo[]> {
  const r = await runTmux(opts, ['list-sessions', '-F', '#{session_name}\t#{session_attached}'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, attached] = line.split('\t')
      return { name, attached: attached === '1' }
    })
}

/**
 * 创建 detached 会话并启动命令，输出 pipe-pane 落盘到日志文件。
 * 返回会话名与日志路径。
 */
export async function startSession(
  opts: TmuxOpts,
  rawName: string,
  command: string,
  cwd?: string,
): Promise<{ name: string; logPath: string; started: boolean }> {
  const name = normalizeSessionName(rawName, opts.prefix)
  if (!command || !command.trim()) throw new Error('命令为空')
  ensureLogDir(opts)
  const startDir = cwd ? resolve(cwd) : homedir()

  // 1. 创建 detached 会话（不依赖 $TMUX，可后台）
  // Windows 后端：命令作为位置参数传给 new-session（bash -c 执行）
  const newArgs =
    process.platform === 'win32'
      ? ['new-session', '-d', '-s', name, '-c', startDir, command]
      : ['new-session', '-d', '-s', name, '-c', startDir]
  const create = await runTmux(opts, newArgs, 30000)
  if (create.code !== 0) {
    // 已存在同名会话
    if (/duplicate session/i.test(create.stderr)) {
      return { name, logPath: logPathFor(opts, name), started: false }
    }
    throw new Error(`创建 tmux 会话失败: ${create.stderr || create.stdout || `code ${create.code}`}`)
  }

  // 2. pipe-pane 落盘日志（-o 追加）
  const pipeCmd = `cat >> ${JSON.stringify(logPathFor(opts, name))}`
  await runTmux(opts, ['pipe-pane', '-t', name, '-o', pipeCmd], 10000)

  // 3. 注入命令并回车（Windows 后端：bash -c 已执行命令——跳过避免 stdin EPIPE）
  if (process.platform !== 'win32') {
    await runTmux(opts, ['send-keys', '-t', name, '-l', command], 10000)
    await runTmux(opts, ['send-keys', '-t', name, 'Enter'], 10000)
  }

  return { name, logPath: logPathFor(opts, name), started: true }
}

export interface ReadOutput {
  text: string
  source: 'log' | 'capture'
  truncated: boolean
}

/** 读取会话输出：优先日志尾部 N 行；日志缺失回退 capture-pane 当前屏幕。 */
export async function readOutput(opts: TmuxOpts, name: string, lines = 100, maxChars = 12000): Promise<ReadOutput> {
  const logPath = logPathFor(opts, name)
  if (existsSync(logPath)) {
    // 只读文件末尾（最多 TAIL_BYTES）：长任务日志数十 MB 时避免每轮 O(n) 全量读 + 阻塞事件循环
    const TAIL_BYTES = 512 * 1024
    let content: string
    let size = 0
    try {
      const fd = openSync(logPath, 'r')
      size = statSync(logPath).size
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      closeSync(fd)
      content = buf.toString('utf-8')
    } catch {
      content = readFileSync(logPath, 'utf-8')  // 兜底：文件不可读时回退全量读
      size = content.length
    }
    const sliced = content.split('\n').slice(-lines).join('\n')
    const truncated = size > maxChars
    return {
      text: truncated ? sliced.slice(-maxChars) : sliced,
      source: 'log',
      truncated: truncated || content.length > sliced.length,
    }
  }
  const r = await runTmux(opts, ['capture-pane', '-t', name, '-p', '-S', String(-lines)])
  const text = r.code === 0 ? r.stdout : '(日志文件不存在且 capture-pane 不可用)'
  return { text, source: 'capture', truncated: text.length > maxChars }
}

export interface SendOpts {
  text?: string
  ctrlKey?: string
  enter?: boolean
}

export async function sendKeys(opts: TmuxOpts, name: string, o: SendOpts): Promise<void> {
  if (o.ctrlKey) {
    const r = await runTmux(opts, ['send-keys', '-t', name, `C-${o.ctrlKey}`])
    if (r.code !== 0) throw new Error(`发送按键失败: ${r.stderr}`)
  }
  if (o.text) {
    const r = await runTmux(opts, ['send-keys', '-t', name, '-l', o.text])
    if (r.code !== 0) throw new Error(`发送文本失败: ${r.stderr}`)
  }
  if (o.enter) {
    const r = await runTmux(opts, ['send-keys', '-t', name, 'Enter'])
    if (r.code !== 0) throw new Error(`发送回车失败: ${r.stderr}`)
  }
}

export async function killSession(opts: TmuxOpts, name: string): Promise<void> {
  const r = await runTmux(opts, ['kill-session', '-t', name])
  if (r.code !== 0) {
    if (/can't find session/i.test(r.stderr)) return
    throw new Error(`结束会话失败: ${r.stderr}`)
  }
}

export interface WaitResult {
  outcome: 'exited' | 'pattern' | 'timeout'
  lastOutput: string
}

/** 轮询等待：会话退出 / 日志出现 pattern / 超时 */
export async function waitSession(
  opts: TmuxOpts,
  name: string,
  pattern: string | undefined,
  timeoutMs: number,
  untilExit: boolean,
): Promise<WaitResult> {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ''
  while (Date.now() < deadline) {
    const alive = await hasSession(opts, name)
    if (!alive) return { outcome: 'exited', lastOutput }
    if (pattern) {
      const out = await readOutput(opts, name, 500, 20000)
      lastOutput = out.text
      if (out.text.includes(pattern)) return { outcome: 'pattern', lastOutput }
    }
    if (untilExit && !pattern) {
      lastOutput = (await readOutput(opts, name, 500, 20000)).text
    }
    await sleep(800)
  }
  if (pattern) lastOutput = (await readOutput(opts, name, 500, 20000)).text
  return { outcome: 'timeout', lastOutput }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** —— 注册表：本扩展创建的 pi- 会话 —— */
export interface RegistryEntry {
  name: string
  logPath: string
  command: string
  createdAt: string
}

export interface Registry {
  sessions: Record<string, RegistryEntry>
}

function registryPath(): string {
  const piHome = process.env.PI_HOME || join(homedir(), '.pi')
  return join(piHome, 'agent', '.pi-tmux-registry.json')
}

export function loadRegistry(): Registry {
  try {
    if (existsSync(registryPath())) {
      return JSON.parse(readFileSync(registryPath(), 'utf-8')) as Registry
    }
  } catch { /* 损坏则重建 */ }
  return { sessions: {} }
}

export function saveRegistry(reg: Registry): void {
  mkdirSync(join(registryPath(), '..'), { recursive: true })
  writeFileSync(registryPath(), JSON.stringify(reg, null, 2), 'utf-8')
}

export function registerSession(entry: RegistryEntry): void {
  const reg = loadRegistry()
  reg.sessions[entry.name] = entry
  saveRegistry(reg)
}

export function unregisterSession(name: string): void {
  const reg = loadRegistry()
  delete reg.sessions[name]
  saveRegistry(reg)
}

export function removeLog(opts: TmuxOpts, name: string): void {
  const p = logPathFor(opts, name)
  try {
    if (existsSync(p)) rmSync(p)
  } catch { /* ignore */ }
}
