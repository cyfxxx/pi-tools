/**
 * pi-tmux core — tmux 会话管理逻辑。
 * 纯模块，不依赖 @earendil-works/pi-coding-agent，便于 vitest 独立测试。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
      // message 不含 ETIMEDOUT——按 killed/signal 判定超时（否则误报 code 1）
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
      if (e.killed === true || e.signal === 'SIGTERM') {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `tmux timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? err.message })
    })
  })
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
  const newArgs = ['new-session', '-d', '-s', name, '-c', startDir]
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

  // 3. 注入命令并回车
  await runTmux(opts, ['send-keys', '-t', name, '-l', command], 10000)
  await runTmux(opts, ['send-keys', '-t', name, 'Enter'], 10000)

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
    const content = readFileSync(logPath, 'utf-8')
    const sliced = content.split('\n').slice(-lines).join('\n')
    const truncated = content.length > maxChars
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
