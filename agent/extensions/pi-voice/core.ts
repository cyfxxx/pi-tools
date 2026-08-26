/**
 * pi-voice core — 录音 / 转码 / 转写 / 朗读 的原子操作。
 * 依赖注入 execFile/spawn/fetch 便于 vitest 独立测试；不依赖 pi API。
 */

import { execFile, spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, existsSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceConfig } from './config'
import { resolvePlatform, platformInstallGuide, TTS_STAGE_FILE, type PlatformSpec } from './platform'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** 秒级时间戳（YYYYMMDD_HHMMSS），用于文件名排序/区分。同一秒内多次调用会碰撞，调用方须追加随机后缀保证唯一。 */
export function nowStamp(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 执行外部命令（argv 数组，无 shell 注入）。超时强制结束。 */
export function runCommand(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<CommandResult> {
  const { timeoutMs = 60000, maxBuffer = 16 * 1024 * 1024 } = opts
  return new Promise((resolvePromise) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer }, (err, stdout, stderr) => {
      if (!err) {
        resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string }
      if (typeof e.code === 'number') {
        resolvePromise({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      if (e.message.includes('ENOENT')) {
        resolvePromise({ code: 127, stdout: '', stderr: `${bin}: command not found` })
        return
      }
      // Node v22 超时杀进程时 err.code=null、signal='SIGTERM'、killed=true，
      // message 不含 ETIMEDOUT——按 killed 判定超时（审计 LOW：e.signal==='SIGTERM'
      // 会把外部 SIGTERM 正常终止的进程也误报 timeout；killed 仅超时自杀时置 true）
      if (e.killed === true) {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? e.message })
    })
  })
}

/** 当前平台活跃的 linux 录音进程（startRecording 记录，stopRecording 终止；termux 平台恒为 null）。 */
let activeLinuxRecorder: { child: ChildProcess; file: string } | null = null

/** 本实例未收尾的 termux 录音会话（审计 MEDIUM 修复：多实例互杀防护门控）。
 *  startRecording 成功 spawn 置位；子进程异常退出（code≠0，服务端大概率未录）、
 *  spawn error、或 stopRecording 执行全局 -q 后作废。termux 的 -q 与残留清理
 *  pkill 作用于 Termux:API 服务侧唯一的 MediaRecorder，多实例并发会误伤其他
 *  实例的活跃录音——仅本实例自身处于活跃录音状态时才放行这些全局操作。 */
let termuxSessionActive = false

/** 获取平台 spec（每次解析，探测开销毫秒级可忽略）。 */
/**
 * GPU 切换预检：返回不可用原因（null = 可切换）。
 * 安卓（termux）无 NVIDIA GPU；linux/windows 需 nvidia-smi 可用
 * （nvidia-smi 存在 ≠ CUDA 库齐备，服务端 auto 探测仍可能判 cpu——见 doctor 提示）。
 */
export function gpuSwitchBlockReason(kind: PlatformSpec['kind'], hasNvidiaSmi: boolean): string | null {
  if (kind === 'termux') return '当前环境无 NVIDIA GPU（安卓），仅支持 cpu / auto'
  if (kind === 'windows' || kind === 'linux') {
    return hasNvidiaSmi ? null : '未检测到 NVIDIA GPU（nvidia-smi 不可用），gpu 切换不可用。可用：cpu / auto'
  }
  return '未知平台，gpu 切换不可用。可用：cpu / auto'
}

export function platformOf(cfg: VoiceConfig): PlatformSpec {
  return resolvePlatform(cfg)
}

/**
 * 启动录音（平台相关）。
 * termux：termux-microphone-record -e aac（m4a，需 ffmpeg 转码）；后台常驻直到 stop。
 * linux：parec 直出 wav（16k 单声道 s16le = whisper 输入格式），前台进程直到 stop。
 * 返回 { child, file }：child 为录音进程，file 为音频输出路径。
 */
export function startRecording(
  cfg: VoiceConfig,
  onExit: (code: number, stderr?: string) => void,
  opts: { forceClean?: boolean } = {},
): { child: ChildProcess; file: string } {
  const spec = platformOf(cfg)
  // 清理残留录音（termux 专用：-q 优雅停止 Termux:API 服务侧的 MediaRecorder，再 pkill
  // 兜底杀 CLI 进程，最后等待服务释放。调用方已拦截进行中的录音，此处不会误杀当前
  // 会话录音。linux 的 parec 无单实例限制，跳过清理）。
  // termux-microphone-record 每次调用（-q/-i）需 ~3s termux-api 通信往返，正常
  // 场景（上次录音已 -q 优雅停止）无残留进程，pgrep 门控跳过整套清理可省
  // ~4.7s 启动延迟；forceClean 用于启动失败后的自动重试（此时服务侧大概率残留）。
  const residue = spec.recorder.residuePattern()
  // 审计 MEDIUM 修复（2026-08-25）：残留清理的 -q/pkill 均为全局操作，本实例无
  // 活跃录音会话时执行会误杀同机其他 pi 实例的录音——仅自身有未收尾会话时放行
  // （多实例安全优先于跨进程崩溃自愈；单实例场景下会话登记已覆盖自愈路径）。
  const allowResidueClean = termuxSessionActive && residue !== null
  let hasResidue = allowResidueClean && opts.forceClean === true
  if (allowResidueClean && !hasResidue) {
    try {
      execFileSync('pgrep', ['-f', residue])
      hasResidue = true
    } catch {
      // 无残留进程：跳过清理直接启动
    }
  }
  if (hasResidue) {
    try {
      execFileSync(spec.recorder.bin, spec.recorder.stopArgs() ?? [], { timeout: 8000 })
    } catch {
      // 无进行中录音或 -q 失败：忽略，继续
    }
    try {
      execFileSync('pkill', ['-f', residue])
    } catch {
      // 无残留进程或 pkill 不可用：忽略
    }
    try {
      execFileSync('sleep', ['1.5'])
    } catch {
      // 非 Unix 环境：忽略
    }
  }
  // 审计：mkdirSync 同步抛穿（如 tmpDir 父级被文件占用 ENOTDIR）难定位——包裹后转
  // 带上下文的友好错误上抛，由调用方状态机按启动失败分流提示。
  try {
    mkdirSync(cfg.tmpDir, { recursive: true })
  } catch (e) {
    throw new Error(`创建录音临时目录失败（tmpDir=${cfg.tmpDir}）: ${(e as Error).message}`)
  }
  const file = join(cfg.tmpDir, `pi-voice-${nowStamp()}-${Math.random().toString(36).slice(2, 8)}.${spec.recorder.ext}`)
  // 时长控制由调用方（dictation）在 Node 侧 setTimeout 到点发停止实现：
  // termux 的 MediaRecorder.setMaxDuration 基于媒体时间戳计时而非墙钟，实际停止
  // 时间与设定值偏差大（实测经常提前一半以上停止），不可依赖；-l 0 = 服务端不限时。
  // linux 的 parec 由 stopRecording 终止进程（无服务端计时概念）。
  const args = spec.recorder.startArgs(file)
  // stdio: 同时捕获 stdout+stderr（termux-microphone-record 的错误信息如
  // "Recording already in progress!" 打到 stdout；stderr 也可能有内容），
  // 报错时可向用户展示真实原因。
  // stdio: 同时捕获 stdout+stderr（termux-microphone-record 的错误信息如
  // "Recording already in progress!" 打到 stdout；stderr 也可能有内容），
  // 报错时可向用户展示真实原因。windows：stdin 需 pipe（stopRecording 写 'q' 优雅停止）。
  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] =
    spec.kind === 'windows' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
  const child = spawn(spec.recorder.bin, args, { stdio })
  if (spec.kind === 'linux' || spec.kind === 'windows') {
    // 审计 MEDIUM 修复：覆盖前先终止仍存活的旧录音进程——热重载/扩展重载时
    // 旧句柄丢失，不杀则 parec/ffmpeg 成孤儿持续占麦克风并向 tmpDir 写文件
    const prev = activeLinuxRecorder
    if (prev && prev.child.exitCode === null && prev.child.pid !== undefined) {
      try { prev.child.kill('SIGTERM') } catch { /* 已退出 */ }
    }
    activeLinuxRecorder = { child, file }
  }
  if (spec.kind === 'termux' && child.pid !== undefined) {
    // 审计 MEDIUM 修复：登记本实例录音会话（后续 stopRecording -q / 残留清理的门控依据）
    termuxSessionActive = true
  }
  let errBuf = ''
  let outBuf = ''
  child.stdout?.on('data', (d: Buffer) => {
    outBuf = (outBuf + d.toString()).slice(-500)
  })
  child.stderr?.on('data', (d: Buffer) => {
    errBuf = (errBuf + d.toString()).slice(-500)
  })
  const capture = (): string | undefined => {
    const combined = [errBuf, outBuf].map(s => s.trim()).filter(Boolean).join(' | ')
    return combined || undefined
  }
  // spawn 失败（如二进制缺失 ENOENT）：必须监听 error，否则 Node 抛 unhandled error；
  // 用退出码 -2 标记启动失败（区别于运行中退出），由状态机按非 0 分流报错。
  child.on('error', () => {
    // 审计 MEDIUM 修复：spawn 失败（如 ENOENT）无服务端会话可言，作废登记防后续误放行 -q
    if (spec.kind === 'termux') termuxSessionActive = false
    onExit(-2, capture())
  })
  child.on('exit', (code) => {
    if (activeLinuxRecorder?.child === child) activeLinuxRecorder = null
    // 审计 MEDIUM 修复：子进程异常退出（启动失败/被占用）→ 会话作废；code===0
    // 保留登记（服务端可能仍在录或待补 -q 收尾 moov atom，见 dictation 续录路径）
    if (spec.kind === 'termux' && (code ?? -1) !== 0) termuxSessionActive = false
    onExit(code ?? -1, capture())
  })
  return { child, file }
}

/**
 * 检测 wav 音量水平（ffmpeg volumedetect）。转写为空时用于区分
 * “麦克风未采集到声音”与“有声音但未识别出”。解析失败返回 null。
 */
export async function detectAudioLevel(
  wavPath: string,
): Promise<{ maxDb: number; meanDb: number } | null> {
  const r = await runCommand(
    'ffmpeg',
    ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', 'null'],
    { timeoutMs: 30000 },
  )
  if (r.code !== 0) return null
  const maxStr = /max_volume: ([-\.\d]+) dB/.exec(r.stderr)?.[1]
  const meanStr = /mean_volume: ([-\.\d]+) dB/.exec(r.stderr)?.[1]
  const maxDb = maxStr ? parseFloat(maxStr) : NaN
  if (Number.isNaN(maxDb)) return null
  return { maxDb, meanDb: meanStr ? parseFloat(meanStr) : -Infinity }
}

/** 停止录音（平台相关）。termux：发 -q 优雅停止服务端 MediaRecorder；linux：直接终止录音进程（SIGTERM → 1s 后 SIGKILL）；windows：写 stdin 'q'（ffmpeg 优雅退出、wav header 完整，2s 超时 SIGKILL 兜底）。 */
export async function stopRecording(cfg: VoiceConfig): Promise<CommandResult> {
  const spec = platformOf(cfg)
  if (spec.kind === 'linux' || spec.kind === 'windows') {
    const rec = activeLinuxRecorder
    if (!rec || rec.child.exitCode !== null || rec.child.pid === undefined) {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (spec.kind === 'windows') {
      // ffmpeg 优雅退出：stdin 'q'（Windows 无 SIGTERM 优雅语义，
      // TerminateProcess 会丢 wav 尾部导致 header 不完整）
      return await new Promise<CommandResult>((resolvePromise) => {
        const killTimer = setTimeout(() => {
          try {
            rec.child.kill('SIGKILL')
          } catch {
            // 已退出
          }
          resolvePromise({ code: 0, stdout: '', stderr: 'stdin q 超时已强制终止' })
        }, 2000)
        rec.child.once('exit', () => {
          clearTimeout(killTimer)
          resolvePromise({ code: 0, stdout: '', stderr: '' })
        })
        try {
          rec.child.stdin?.write('q')
        } catch {
          clearTimeout(killTimer)
          resolvePromise({ code: 0, stdout: '', stderr: '' })
        }
      })
    }
    return await new Promise<CommandResult>((resolvePromise) => {
      const pid = rec.child.pid as number
      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已退出
        }
        resolvePromise({ code: 0, stdout: '', stderr: 'SIGTERM 超时已强制终止' })
      }, 1000)
      rec.child.once('exit', () => {
        clearTimeout(killTimer)
        resolvePromise({ code: 0, stdout: '', stderr: '' })
      })
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        clearTimeout(killTimer)
        resolvePromise({ code: 0, stdout: '', stderr: '' })
      }
    })
  }
  // 审计 MEDIUM 修复：本实例无未收尾录音会话时不发全局 -q——该命令停掉的是
  // Termux:API 服务侧唯一的 MediaRecorder，多实例下会误停其他实例的活跃录音
  if (!termuxSessionActive) {
    return { code: 0, stdout: '', stderr: '' }
  }
  termuxSessionActive = false
  return runCommand(spec.recorder.bin, spec.recorder.stopArgs() ?? ['-q'], { timeoutMs: 15000 })
}

/**
 * 查询当前录音状态（平台相关）。termux：termux-microphone-record -i（JSON），断线续录判定用；
 * linux：进程退出即结束、无需续录判定，返回 null（调用方按异常处理）。
 * 调用失败或解析失败返回 null。
 */
export async function queryRecording(cfg: VoiceConfig): Promise<{ isRecording: boolean } | null> {
  const spec = platformOf(cfg)
  if (spec.recorder.queryArgs() === null) return null
  const r = await runCommand(spec.recorder.bin, spec.recorder.queryArgs()!, { timeoutMs: 10000 })
  if (r.code !== 0) return null
  try {
    const data = JSON.parse(r.stdout.trim()) as { isRecording?: unknown }
    return { isRecording: data?.isRecording === true }
  } catch {
    return null
  }
}

/** 删除一次录音产出的 m4a + wav 文件（即用即弃：转写后立即清除）。 */
export function deleteAudioPair(cfg: VoiceConfig, m4a: string): void {
  for (const p of [m4a, m4a.replace(/\.m4a$/, '.wav')]) {
    try {
      rmSync(p, { force: true })
    } catch {
      // 删除失败不阻塞主流程
    }
  }
}

/** 判断录音文件是否已生成（用于区分“正常超时退出”与“启动即失败/被占用”）。 */
export function fileExists(m4a: string): boolean {
  try {
    return existsSync(m4a) && statSync(m4a).size > 0
  } catch {
    return false
  }
}

/**
 * 等待 m4a 文件出现且大小稳定。
 * termux-microphone-record（Termux:API MediaRecorder）的 bash 脚本退出（exit 0）后，
 * Android 侧仍会继续写入文件（m4a 的 moov atom 在文件尾部），立即转码会报
 * "moov atom not found"；文件也可能延迟创建（启动瞬间为 0 字节）。
 * 连续 stableSamples 次采样大小一致（且 > 0）视为写入完成。
 * 返回 true = 文件就绪；false = 超时（未创建或一直未稳定）。
 */
export async function waitForFileStable(
  m4a: string,
  opts: { pollMs?: number; stableSamples?: number; maxWaitMs?: number } = {},
): Promise<boolean> {
  const { pollMs = 300, stableSamples = 3, maxWaitMs = 15000 } = opts
  const deadline = Date.now() + maxWaitMs
  let lastSize = -1
  let stable = 0
  while (Date.now() < deadline) {
    let size = 0
    try {
      size = statSync(m4a).size
    } catch {
      size = 0
    }
    if (size > 0) {
      if (size === lastSize) {
        stable += 1
      } else {
        // 首个有效样本也计一次疑似稳定：文件已写完时无需多等一个轮询周期
        stable = lastSize === -1 ? 1 : 0
      }
      lastSize = size
      if (stable >= stableSamples) return true
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

/** 清理录音临时目录中超过 staleMs 的残留文件（默认 24h，避免误删进行中录音）。返回清理数。 */
export function cleanupStaleAudio(cfg: VoiceConfig, staleMs = 24 * 60 * 60 * 1000): number {
  let removed = 0
  let names: string[] = []
  try {
    names = readdirSync(cfg.tmpDir)
  } catch {
    return 0
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.m4a') && !name.endsWith('.wav')) continue
    const full = join(cfg.tmpDir, name)
    try {
      if (now - statSync(full).mtimeMs > staleMs) {
        rmSync(full, { force: true })
        removed += 1
      }
    } catch {
      // 文件已被删或 stat 失败，忽略
    }
  }
  return removed
}

/** 转码（平台相关）。termux：m4a → 16kHz 单声道 wav（whisper 输入格式），失败时 error 携带 ffmpeg stderr（截断）；linux：录音已直出 wav，原样返回。 */
export async function convertToWav(cfg: VoiceConfig, m4a: string): Promise<{ wav: string | null; error: string }> {
  if (!platformOf(cfg).recorder.needsConvert) return { wav: m4a, error: '' }
  const wav = m4a.replace(/\.m4a$/, '.wav')
  const res = await runCommand(cfg.ffmpegBin, [
    '-y', '-loglevel', 'error',
    '-i', m4a,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wav,
  ], { timeoutMs: 30000 })
  if (res.code === 0) return { wav, error: '' }
  const err = res.stderr.trim() || res.stdout.trim()
  return { wav: null, error: err ? err.slice(0, 200) : `ffmpeg 退出码 ${res.code}` }
}

export interface TranscribeResult {
  text: string
  language: string
  error?: string
}

/**
 * 确保 whisper 常驻服务在线（转写前调用）。
 * 服务未启动或已退出时自动执行 pi-whisper.sh start 拉起，并轮询等待就绪。
 * 返回 { ok: true } 或 { ok: false, error }。
 * deps 可注入（单测）：默认 health = 带 token 的 HTTP 检查、start = bash 脚本。
 */
export interface EnsureWhisperDeps {
  health?: () => Promise<boolean>
  start?: () => Promise<CommandResult>
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

export function defaultWhisperHealth(cfg: VoiceConfig): () => Promise<boolean> {
  return async () => {
    try {
      const headers: Record<string, string> = {}
      if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
      const res = await fetch(`${cfg.whisperEndpoint}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

/** sherpa (SenseVoice) 服务健康检查。token 优先 sherpaToken（服务端读 sherpaToken→回退 whisperToken）。 */
export function defaultSherpaHealth(cfg: VoiceConfig): () => Promise<boolean> {
  return async () => {
    try {
      const headers: Record<string, string> = {}
      if (cfg.sherpaToken) headers['Authorization'] = `Bearer ${cfg.sherpaToken}`
      const res = await fetch(`${cfg.sherpaEndpoint}/health`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

export async function ensureWhisperService(
  cfg: VoiceConfig,
  deps: EnsureWhisperDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    health = defaultWhisperHealth(cfg),
    start = () => {
      // Windows 便携版：服务由 start.bat 的 check-services.js 端口检测拉起（spawn python
      // detached + venv 路径/端口/模型全部正确）；Linux 走 pi-whisper.sh
      if (process.platform === 'win32') {
        // 审计 LOW 修复：USERPROFILE 缺失时原退化 root=join('')='.' 拼出相对路径探测，
        // cwd 巧合命中会以错误根目录拉起服务——缺失则明确跳过 win32 探测，走下方
        // bash 脚本通用路径（其错误信息自带修复指引）
        const root = process.env.USERPROFILE
        if (root) {
          const nodeExe = join(root, 'node', 'node.exe')
          const checker = join(root, 'bin', 'check-services.js')
          if (existsSync(nodeExe) && existsSync(checker)) {
            return runCommand(nodeExe, [checker], { timeoutMs: 30000 })
          }
        }
      }
      return runCommand('bash', [cfg.whisperScript, 'start'], { timeoutMs: 30000 })
    },
    pollIntervalMs = 2000,
    pollTimeoutMs = 120000,
  } = deps
  if (await health()) return { ok: true }
  // 服务不在线：尝试自动拉起（bash 脚本，模型加载可能需要数十秒）
  const res = await start()
  if (res.code !== 0) {
    return { ok: false, error: `whisper 服务不可用且自动启动失败：${res.stderr.trim() || res.stdout.trim() || '未知错误'}（可手动运行 bash ${cfg.whisperScript} start）` }
  }
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    if (await health()) return { ok: true }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  return { ok: false, error: `whisper 服务自动启动后仍不可达（${cfg.whisperEndpoint}），请检查 ~/.pi/logs/whisper/server.log` }
}

/** 调 whisper 常驻服务转写 wav 字节。 */
export async function transcribe(cfg: VoiceConfig, wavPath: string): Promise<TranscribeResult> {
  const ready = await ensureWhisperService(cfg)
  if (!ready.ok) {
    return { text: '', language: '', error: (ready as { ok: false; error: string }).error }
  }
  let body: Buffer
  try {
    body = readFileSync(wavPath)
  } catch (e) {
    return { text: '', language: '', error: `读取 wav 失败: ${(e as Error).message}` }
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'Content-Length': String(body.length),
    }
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    // cfg.language 非空时固定转写语言（如 zh），避免 whisper 自动检测误判
    const url = cfg.language
      ? `${cfg.whisperEndpoint}/transcribe?lang=${encodeURIComponent(cfg.language)}`
      : `${cfg.whisperEndpoint}/transcribe`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return { text: '', language: '', error: `whisper 服务返回 ${res.status}` }
    }
    const data = (await res.json()) as { text?: string; language?: string; error?: string }
    if (data.error) return { text: '', language: '', error: data.error }
    return { text: data.text ?? '', language: data.language ?? '' }
  } catch (e) {
    return { text: '', language: '', error: `whisper 服务不可达: ${(e as Error).message}` }
  }
}

/** sherpa (SenseVoice) 服务启停：与 ensureWhisperService 语义一致的独立后背。 */
export async function ensureSherpaService(
  cfg: VoiceConfig,
  deps: EnsureWhisperDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    health = defaultSherpaHealth(cfg),
    start = () => runCommand('bash', [cfg.sherpaScript, 'start'], { timeoutMs: 30000 }),
    pollIntervalMs = 2000,
    pollTimeoutMs = 120000,
  } = deps
  if (await health()) return { ok: true }
  const res = await start()
  if (res.code !== 0) {
    return { ok: false, error: `sherpa 服务不可用且自动启动失败：${res.stderr.trim() || res.stdout.trim() || '未知错误'}（可手动运行 bash ${cfg.sherpaScript} start）` }
  }
  const deadline = Date.now() + pollTimeoutMs
  while (Date.now() < deadline) {
    if (await health()) return { ok: true }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
  return { ok: false, error: `sherpa 服务自动启动后仍不可达（${cfg.sherpaEndpoint}），请检查 ~/.pi/logs/sherpa/server.log` }
}

/** 调 sherpa-onnx (SenseVoice) 常驻服务转写 wav 字节（输入须 16k 单声道；客户端 convertToWav 已满足）。 */
export async function transcribeSherpa(cfg: VoiceConfig, wavPath: string): Promise<TranscribeResult> {
  const ready = await ensureSherpaService(cfg)
  if (!ready.ok) {
    return { text: '', language: '', error: (ready as { ok: false; error: string }).error }
  }
  let body: Buffer
  try {
    body = readFileSync(wavPath)
  } catch (e) {
    return { text: '', language: '', error: `读取 wav 失败: ${(e as Error).message}` }
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'audio/wav',
      'Content-Length': String(body.length),
    }
    if (cfg.sherpaToken) headers['Authorization'] = `Bearer ${cfg.sherpaToken}`
    const res = await fetch(`${cfg.sherpaEndpoint}/transcribe`, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) {
      return { text: '', language: '', error: `sherpa 服务返回 ${res.status}` }
    }
    const data = (await res.json()) as { text?: string; language?: string; error?: string }
    if (data.error) return { text: '', language: '', error: data.error }
    return { text: data.text ?? '', language: cfg.language }
  } catch (e) {
    return { text: '', language: '', error: `sherpa 服务不可达: ${(e as Error).message}` }
  }
}

/** 按 cfg.sttBackend 选择转写后端（dictation 注入用；默认 whisper 行为不变）。 */
export async function transcribeByBackend(cfg: VoiceConfig, wavPath: string): Promise<TranscribeResult> {
  return cfg.sttBackend === 'sherpa' ? transcribeSherpa(cfg, wavPath) : transcribe(cfg, wavPath)
}

/** 录音前预拉起 STT 后端：sherpa 时顺带触发模型加载（/health 内懒加载），
 *  消除首次转写的模型加载等待（录音启动 1-2s 窗口内完成）；失败静默，转写路径会再检查。 */
export async function prewarmStt(cfg: VoiceConfig): Promise<void> {
  if (cfg.sttBackend !== 'sherpa') return
  try {
    await ensureSherpaService(cfg)
  } catch {
    // 忽略：转写时会再次检查并给出提示
  }
}

/** TTS 朗读（平台相关）。termux：termux-tts-speak 单参数；linux：合成引擎（espeak-ng/piper）生成 wav → paplay 播放 → 清理暂存。 */
export async function speak(cfg: VoiceConfig, text: string): Promise<CommandResult> {
  const clean = cleanForSpeech(text, cfg.ttsMaxChars)
  if (!clean) return { code: 0, stdout: '', stderr: '（空文本，跳过朗读）' }
  const spec = platformOf(cfg)
  // 直接朗读路径：termux 平台（termux-tts-speak）或 tts 引擎声明为直接朗读
  // （windows SAPI 的 tts.kind='termux'——speakArgs 直接调 PowerShell；
  // 2026-08-14 修复：原判断只看 spec.kind，windows 平台误走两段式 → 空参数
  // 调 powershell 挂起 60s 超时）
  if (spec.kind === 'termux' || spec.tts.kind === 'termux') {
    // termux-tts-speak 一次只接受一个参数，文本须作为单个 argv 传入
    return runCommand(spec.tts.bin, spec.tts.speakArgs(clean), { timeoutMs: 60000 })
  }
  // linux 两段式：合成引擎生成 wav（espeak-ng -f/-w 或 piper -m/-i/-f），paplay 播放（可指定 sink）
  mkdirSync(cfg.tmpDir, { recursive: true })
  // 审计修复（MEDIUM）：固定名 tts-stage.wav 同机双实例并发朗读互删暂存 wav——
  // 参照下方 textFile 已有的 -pid 后缀模式隔离；synthesizeArgs 写入/playArgs 播放/
  // finally 清理同用本变量，天然一致
  const stage = join(
    cfg.tmpDir,
    TTS_STAGE_FILE.split('/').pop()!.replace(/\.wav$/, `-${process.pid}.wav`),
  )
  // 统一文本文件输入（espeak-ng -f / piper -i），避免 stdin 与特殊字符差异
  // 审计修复：固定名 tts-input.txt 同机双实例互写——加 pid 后缀隔离；写入与
  // synthesizeArgs(textFile) 读取同用本变量天然一致，finally 统一清理
  const textFile = join(cfg.tmpDir, `tts-input-${process.pid}.txt`)
  try {
    writeFileSync(textFile, clean, 'utf-8')
  } catch (e) {
    return { code: 1, stdout: '', stderr: `写入 TTS 文本失败: ${(e as Error).message}` }
  }
  try {
    const gen = await runCommand(spec.tts.bin, spec.tts.synthesizeArgs(textFile, stage), { timeoutMs: 60000 })
    if (gen.code !== 0) {
      const hint =
        spec.tts.kind === 'piper'
          ? `（请确认已安装 piper-tts 且模型存在：${cfg.linuxPiperModel}）`
          : '（请确认已安装 espeak-ng：apt-get install espeak-ng）'
      return { ...gen, stderr: `${gen.stderr.trim()}${hint}` }
    }
    try {
      const playArgs = spec.tts.playArgs(stage)
      if (!playArgs) return { code: 0, stdout: '', stderr: '' }
      return await runCommand('paplay', playArgs, { timeoutMs: 60000 })
    } finally {
      try {
        rmSync(stage, { force: true })
      } catch {
        // 清理失败不阻塞
      }
    }
  } finally {
    try {
      rmSync(textFile, { force: true })
    } catch {
      // 清理失败不阻塞
    }
  }
}

export function cleanForSpeech(text: string, maxChars = 400): string {
  let out = text
    // 移除代码块
    .replace(/```[\s\S]*?```/g, ' ')
    // 移出行内代码
    .replace(/`([^`]*)`/g, '$1')
    // 链接 [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 标题/列表/引用标记
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, ' ')
    .replace(/^\s*>\s*/gm, ' ')
    .replace(/^\s*\d+\.\s+/gm, ' ')
    // 强调 / 粗体 / 斜体
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  out = out.replace(/([，。！？!?；;：:,])\s+/g, '$1')
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}...`
  return out
}

/**
 * 判断文本是否值得朗读：过滤 JSON/结构化摘要（会话总结、记忆等），
 * 以及过短（<2 字符）或全为符号/空白的文本。自动朗读与手动 /tts speak 均过滤，
 * 手动朗读被过滤时会明确提示原因（不静默）。
 */
export function isSpeechWorthy(text: string): boolean {
  const t = text.trim()
  if (t.length < 2) return false
  if (/^[{[]/.test(t)) return false
  if (/^[\s`~\-*#_>|+]+$/.test(t)) return false
  return true
}

export interface TtsDispatcherOptions {
  speakFn: (text: string) => Promise<CommandResult>
  onError?: (message: string) => void
}

export interface TtsDispatcher {
  /** 加入朗读队列。合并策略：同时只保留一条待读文本（新文本替换旧的），
   *  中间内容无需朗读；串行执行，同一时刻只有一条在朗读。 */
  enqueue(text: string): void
  /** 当前是否正在朗读（不含待读队列）。 */
  isSpeaking(): boolean
  /** 待读队列长度（合并后恒为 0 或 1）。 */
  pendingCount(): number
  /** 等待队列排空（含正在朗读的），测试与退出清理用。 */
  flush(): Promise<void>
}

/**
 * TTS 串行调度器：一次只朗读一条；新文本到来时丢弃中间待读内容，只读最新。
 * speakFn 返回 CommandResult（code!==0 视为失败，经 onError 回调，不吞错）。
 */
export function createTtsDispatcher(opts: TtsDispatcherOptions): TtsDispatcher {
  let pending: string | null = null
  let speaking = false
  let chain: Promise<void> = Promise.resolve()
  let idle = true

  function pump(): void {
    if (!idle) return
    idle = false
    chain = chain.then(async () => {
      try {
        while (pending !== null) {
          const text = pending
          pending = null
          speaking = true
          try {
            const r = await opts.speakFn(text)
            if (r.code !== 0) opts.onError?.(r.stderr.trim() || r.stdout.trim() || `朗读进程退出码 ${r.code}`)
          } catch (e) {
            opts.onError?.((e as Error).message)
          } finally {
            speaking = false
          }
        }
      } finally {
        idle = true
      }
    })
  }

  return {
    enqueue(text: string) {
      pending = text
      pump()
    },
    isSpeaking: () => speaking,
    pendingCount: () => (pending === null ? 0 : 1),
    flush: () => chain,
  }
}

/** 从 assistant 消息 content 提取纯文本（对齐 pi AgentMessage.content 结构）。 */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === 'object')
      .filter((p) => (p.type ?? '') === 'text')
      .map((p) => p.text ?? '')
      .join('\n')
  }
  return ''
}

/** 诊断：逐项检查录音 / 转写 / 朗读 依赖（平台相关）。 */
export async function doctor(cfg: VoiceConfig): Promise<string[]> {
  const spec = platformOf(cfg)
  const lines: string[] = []
  // 1. 录音二进制 + 权限
  const probeArgs = spec.recorder.queryArgs()
  const mic = probeArgs !== null ? await runCommand(spec.recorder.bin, probeArgs, { timeoutMs: 10000 }) : null
  if (mic === null) {
    // linux：无 -i 查询，用 --version 探测命令存在性
    const ver = await runCommand(spec.recorder.bin, ['--version'], { timeoutMs: 10000 })
    lines.push(ver.code === 127 ? `✗ 录音命令 ${spec.recorder.bin} 缺失：${spec.recorder.installHint}` : `✓ 录音命令可用（${spec.recorder.micLabel}）`)
  } else if (mic.code === 127) {
    lines.push(`✗ 录音命令 ${spec.recorder.bin} 缺失：${spec.recorder.installHint}`)
  } else if (mic.stderr.toLowerCase().includes('permission') || mic.stderr.toLowerCase().includes('record_audio')) {
    lines.push(`✗ 麦克风权限未授予：${spec.recorder.permissionHint}`)
  } else {
    if (spec.kind === 'windows' && !cfg.micDevice) {
      lines.push(`✗ 未配置 dshow 麦克风设备（micDevice）。枚举：ffmpeg -list_devices true -f dshow -i dummy；配置：pi-voice.json 加 "micDevice": "麦克风 (Realtek(R) Audio)"`)
    } else {
      lines.push(`✓ 麦克风可用（${spec.recorder.micLabel}）`)
    }
  }
  // 2. ffmpeg（termux 转码必需；linux 录音直出 wav，但 detectAudioLevel 的
  // volumedetect 音量检测仍依赖 ffmpeg——缺失仅 info 提示，不判失败）
  if (spec.recorder.needsConvert) {
    const ff = await runCommand(cfg.ffmpegBin, ['-version'], { timeoutMs: 10000 })
    lines.push(ff.code === 0 ? '✓ ffmpeg 可用' : '✗ ffmpeg 缺失：请 apt-get install ffmpeg')
  } else if (spec.kind === 'linux') {
    const ff = await runCommand('ffmpeg', ['-version'], { timeoutMs: 10000 })
    if (ff.code !== 0) {
      lines.push('ℹ ffmpeg 缺失（可选）：录音/转写不受影响，但音量检测不可用，无法区分「麦克风无声」与「有声音未识别」。可选安装：apt-get install ffmpeg')
    }
  }
  // 3. whisper 服务（带 token，与服务端鉴权一致；否则配置 token 后必误报不可达）
  let actualDevice: string | null = null
  try {
    const headers: Record<string, string> = {}
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    const res = await fetch(`${cfg.whisperEndpoint}/health`, { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      lines.push('✗ whisper 服务鉴权失败（401）：token 与 ~/.pi/scripts/pi-whisper.sh 读取的配置不一致')
    } else {
      const data = (await res.json()) as { ok?: boolean; model?: string; device?: string }
      actualDevice = data.device ?? null
      lines.push(data.ok ? `✓ whisper 服务可用（模型 ${data.model ?? ''}${actualDevice ? `，${actualDevice}` : ''}）` : '✓ whisper 服务运行中（模型加载中）')
    }
  } catch {
    lines.push('✗ whisper 服务不可达：请运行 ~/.pi/scripts/pi-whisper.sh start')
  }
  // 4. sherpa (SenseVoice) 服务（独立后端，端口 18768）
  try {
    const headers: Record<string, string> = {}
    if (cfg.sherpaToken) headers['Authorization'] = `Bearer ${cfg.sherpaToken}`
    const res = await fetch(`${cfg.sherpaEndpoint}/health`, { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      lines.push('✗ sherpa 服务鉴权失败（401）：token 与 ~/.pi/scripts/pi-sherpa.sh 读取的配置不一致')
    } else {
      const data = (await res.json()) as { ok?: boolean; model?: string }
      lines.push(data.ok ? `✓ sherpa 服务可用（模型 ${data.model ?? ''}）` : '✓ sherpa 服务运行中（模型加载中）')
    }
  } catch {
    lines.push(`✗ sherpa 服务不可达：请运行 ~/.pi/scripts/pi-sherpa.sh start（当前后端 ${cfg.sttBackend === 'sherpa' ? '正使用' : '未使用'}）`)
  }
  // 5. GPU 推理提示：以服务端实际设备为准（nvidia-smi 可用 ≠ whisper 用 cuda；
  // 2026-08-14 实测：驱动可见但缺 cublas/cudnn 库时服务端 auto 探测判 cpu，此处曾误报）
  if (spec.kind === 'linux' || spec.kind === 'windows') {
    if (actualDevice === 'cuda') {
      lines.push('✓ whisper 在 GPU (cuda) 上推理（可 /voice model small 提升准确率）')
    } else {
      const hasGpu = await runCommand('nvidia-smi', [], { timeoutMs: 5000 })
      if (hasGpu.code === 0) {
        lines.push('⚠ 检测到 NVIDIA GPU 但 whisper 在 CPU 推理（缺 CUDA 库或 auto 探测判 cpu，/voice device 可查看与切换）')
      } else {
        lines.push('ℹ whisper 在 CPU 推理（未检测到 NVIDIA GPU）')
      }
    }
  }
  // 6. TTS
  const ttsCheck = spec.tts.checkArgs()
  if (ttsCheck === null) {
    lines.push(`✓ TTS 命令可用（${spec.tts.label}）`)
  } else {
    const tts = await runCommand(spec.tts.bin, ttsCheck, { timeoutMs: 10000 })
    if (tts.code === 127) {
      lines.push(`✗ TTS 命令 ${spec.tts.bin} 缺失：${spec.kind === 'linux' ? 'apt-get install espeak-ng' : 'Termux:TTS 未安装（termux-tts-speak）'}`)
    } else {
      lines.push(`✓ TTS 命令可用（${spec.tts.label}）`)
    }
  }
  return lines
}

/** 生成可安装指引错误（供模型直接修复环境）。平台相关。 */
export function voiceGuideError(cfg: VoiceConfig, detail: string): string {
  const spec = platformOf(cfg)
  return `语音功能不可用：${detail}\n修复指引：\n${platformInstallGuide(spec)}`
}

export interface BenchResult {
  lines: string[]
  /** 实时率：转写耗时 / 音频时长；测试失败为 null */
  rtf: number | null
}

/** 模型档位建议（纯函数，便于单测）。rtf > 1 = 慢于实时，< 0.5 = 明显快于实时。 */
export function benchSuggestion(rtf: number): string {
  if (rtf > 1) return '转写慢于实时语速，建议换更小模型（/voice model tiny）提升速度'
  if (rtf > 0.5) return '速度可接受；若追求准确率可尝试更大模型，若追求响应可换 tiny'
  return '速度充裕（快于实时 2 倍以上），可尝试更大模型提升准确率（/voice model small）'
}

/** 性能基准：录 5s 音频 → 转写计时 → 返回评估行与 RTF。失败时 rtf 为 null。 */
export async function benchmark(cfg: VoiceConfig): Promise<BenchResult> {
  // 注意：maxSeconds 仅对 -l 参数生效，termux 启动参数是 -l 0（服务端不限时）、
  // linux parec 无时长参数——录音进程不会自行退出，必须在 Node 侧定时停止
  const t0 = Date.now()
  const rec = startRecording(cfg, () => {})
  const file = rec.file
  // 录 5s 后主动停止（补 -q 让服务侧收尾写 moov atom）；15s 兜底防 stop 失败挂起
  const stopTimer = setTimeout(() => {
    void stopRecording(cfg).catch(() => undefined)
  }, 5000)
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (rec.child.exitCode !== null) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 15000)
  })
  clearTimeout(stopTimer)
  const recordedMs = Math.max(Date.now() - t0, 1)
  // 进程退出 ≠ 收尾：MediaRecorder 在 -l 超时/被杀时不写 moov atom（实测），
  // 必须补 -q 强制服务收尾，再等文件稳定（moov 写入完成）才能转码。
  await stopRecording(cfg).catch(() => undefined)
  await waitForFileStable(file)
  if (!fileExists(file)) {
    deleteAudioPair(cfg, file)
    return { lines: ['✗ 基准测试失败：录音未生成文件（检查麦克风权限与 termux-api）'], rtf: null }
  }
  const { wav } = await convertToWav(cfg, file)
  if (!wav) {
    deleteAudioPair(cfg, file)
    return { lines: ['✗ 基准测试失败：m4a 转 wav 失败（检查 ffmpeg）'], rtf: null }
  }
  const t1 = Date.now()
  const r = await transcribeByBackend(cfg, wav)
  const transcribeMs = Date.now() - t1
  deleteAudioPair(cfg, file)
  if (r.error) return { lines: [`✗ 转写失败：${r.error}`], rtf: null }
  const audioSec = recordedMs / 1000
  const rtf = transcribeMs / 1000 / audioSec
  const backendLabel = cfg.sttBackend === 'sherpa' ? `sherpa (SenseVoice)` : `whisper (${cfg.whisperModel})`
  const lines = [
    `后端/模型：${backendLabel}`,
    `音频：${audioSec.toFixed(1)}s；转写耗时：${(transcribeMs / 1000).toFixed(1)}s`,
    `实时率 RTF：${rtf.toFixed(2)}（${rtf <= 1 ? '快于实时' : '慢于实时'}）`,
    `建议：${benchSuggestion(rtf)}`,
  ]
  return { lines, rtf }
}

// ---- KWS 唤醒监听（/voice wake，Linux 平台） ----
// Termux 录音 API 无实时 PCM 流（MediaRecorder 仅 aac/amr），无法持续监听；
// Linux（parec 直出 s16le 到 stdout）可直接流式采音 → POST sherpa 服务 /wake 检测。

const WAKE_RING_MS = 3000 // 环形缓冲保留最近 3s 音频
const WAKE_UPLOAD_MS = 2500 // 每次检测上传最近 2.5s
const WAKE_POLL_MS = 500 // 检测间隔
// 采集停滞看门狗：WSLg 的 RDP 麦克风源会挂起长时间未活动 client 的 stream（新建 stream
// 正常、常驻 stream 无数据），导致 ring 恒空、poll 永不发请求。连续 N ms 无新数据则
// 重启 parec（kill+respawn 会拿到新 stream）；连续重启仍无数据说明无真实输入，停止并提示。
const WAKE_STALL_MS = 8000 // ring 停滞判定阈值
const WAKE_MIN_ALIVE_MS = 8000 // spawn 后 8s 内不判定（启动窗口，与停滞阈值同长，避免重启后紧接着再判定）
const WAKE_MAX_RESTARTS = 3 // 连续停滞重启上限
const WAKE_FILE_MAX_BYTES = 64 * 1024 * 1024 // 采集 wav 文件上限（~35min）；超限滚动重启，防无限增长
const WAV_HEADER_LEN = 44 // 标准 PCM wav 头长度（parec --file-format=wav 直出）
// 采集走文件而非 stdout：pi 扩展沙箱下 spawn 的 stdout 被替换为 IPC socket，长时间
// 流式数据不达（实测 0 字节），而文件模式（dictation 同款参数）稳定可靠。

/** 唤醒监听器：持续从麦克风采 PCM，轮询 sherpa 服务 /wake 检测唤醒词。 */
export interface WakeSession {
  start(): Promise<void>
  stop(): string
  isRunning(): boolean
  hits(): number
}

export interface WakeOptions {
  onHit: (keyword: string) => void
  onStatus: (status: string) => void
}

/** 构造唤醒会话；非 linux 平台直接抛错（带原因）。需 cfg.sttBackend===sherpa。 */
export function createWakeSession(cfg: VoiceConfig, opts: WakeOptions): WakeSession {
  const spec = platformOf(cfg)
  if (spec.kind !== 'linux') {
    throw new Error('唤醒监听仅支持 Linux 平台（Termux 录音 API 无实时 PCM 流；Windows 暂未支持）')
  }

  let child: ChildProcess | null = null
  let ring: Buffer = Buffer.alloc(0)
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let hitCount = 0
  let inFlight = false
  let lastDataAt = 0 // 最近一次收到 PCM 的时间（0 = 从未）
  let spawnAt = 0 // 当前 parec 的 spawn 时间
  let restartCount = 0 // 连续停滞重启次数（拿到数据后清零）
  let lastReadPos = 0 // wakeFile 已读取字节偏移（跳过 wav 头）
  const wakeFile = join(cfg.tmpDir, 'wake-listen.wav')

  const appender = (buf: Buffer): void => {
    lastDataAt = Date.now()
    restartCount = 0 // 有数据流入即认为采集健康
    ring = Buffer.concat([ring, buf])
    const cap = WAKE_RING_MS * 16 * 2 // 16kHz×2字节×秒数 = 3s≈96KB
    if (ring.length > cap) ring = ring.subarray(ring.length - cap)
  }

  // 从采集文件读取新增字节（poll 前调用）。首读只定位到数据区起点（跳过 wav 头）。
  const fileRead = (): void => {
    try {
      const st = statSync(wakeFile)
      if (st.size <= WAV_HEADER_LEN) return
      if (lastReadPos === 0) {
        lastReadPos = WAV_HEADER_LEN
        return
      }
      if (st.size <= lastReadPos) return
      const fd = openSync(wakeFile, 'r')
      try {
        const len = Math.min(st.size - lastReadPos, 64 * 1024)
        const b = Buffer.alloc(len)
        const n = readSync(fd, b, 0, len, lastReadPos)
        if (n > 0) {
          lastReadPos += n
          appender(b.subarray(0, n))
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // 文件暂不存在/不可读：静默，等下一轮（重启流程删除文件后窗口期属正常）
    }
  }

  const poll = async (): Promise<void> => {
    if (!running || inFlight) return
    fileRead()
    // 审计 MEDIUM：文件超上限滚动重启，保证采集文件体长有界
    try {
      if (statSync(wakeFile).size > WAKE_FILE_MAX_BYTES) {
        rolloverFile()
        return
      }
    } catch { /* 文件暂不可读：下轮再判 */ }
    if (ring.length < 16000) return // 不足 1s 不上传，避免反复空检测
    const upLen = WAKE_UPLOAD_MS * 16 * 2
    const seg = ring.length > upLen ? ring.subarray(ring.length - upLen) : ring
    inFlight = true
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
      if (cfg.sherpaToken) headers['Authorization'] = `Bearer ${cfg.sherpaToken}`
      const res = await fetch(`${cfg.sherpaEndpoint}/wake`, {
        method: 'POST',
        headers,
        body: new Uint8Array(seg),
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const data = (await res.json()) as { hits?: string[] }
        if (data.hits && data.hits.length > 0) {
          hitCount += data.hits.length
          opts.onHit(data.hits[0])
          ring = Buffer.alloc(0) // 命中后清空，避免同一词重复触发
        }
      }
    } catch {
      // 服务临时不可达：静默跳过本轮，下轮重试
    } finally {
      inFlight = false
    }
  }

  // spawn parec 采集进程（start 与看门狗重启共用）。采集写入 wav 文件（pi 扩展沙箱
  // 下 stdout pipe 不可靠——实测 IPC socket 化后流式数据不达），Node 侧周期读文件尾部。
  const spawnRecorder = (): void => {
    const args: string[] = []
    if (cfg.linuxMicDevice) args.push('--device', cfg.linuxMicDevice)
    args.push('--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', wakeFile)
    child = spawn(cfg.micBin === 'termux-microphone-record' ? 'parec' : cfg.micBin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    spawnAt = Date.now()
    lastReadPos = 0
    child.on('error', (e) => {
      running = false
      // 审计 LOW（2026-08-25）：error 分支此前只置 running=false，500ms poll/guard
      // 定时器永久空转泄漏——与 exit 分支同款清理
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      opts.onStatus(`唤醒监听启动失败：${(e as Error).message}`)
    })
    child.on('exit', (code) => {
      if (running) {
        running = false
        // 审计 LOW（2026-08-25）：意外退出后 500ms poll/guard 定时器永久空转——顺手清理
        // （stop() 路径 running 已 false，不受影响）
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        opts.onStatus(code === 0 ? '唤醒监听已停止' : `唤醒监听异常退出（${code ?? '?'}）`)
      }
    })
  }

  // 采集文件滚动重启（审计 MEDIUM/2026-08-24）：wav 只读尾不截断，长时间监听
  // 文件无界增长（16kHz×2B≈31KB/s≈110MB/h）。文件超上限时滚动采集进程让文件有界
  // （数据健康滚动，不计数停滞重启）。
  const rolloverFile = (): void => {
    if (!child) return
    const stale = child
    stale.removeAllListeners('exit')
    stale.removeAllListeners('error')
    child = null
    ring = Buffer.alloc(0)
    lastDataAt = 0
    lastReadPos = 0
    stale.kill('SIGKILL')
    rmSync(wakeFile, { force: true })
    spawnRecorder()
  }

  // 采集停滞看门狗：parec 存活但长时间无数据 → 判定 stream 挂起，重启采集进程。
  const guard = (): void => {
    if (!running || !child || child.exitCode !== null) return
    if (Date.now() - spawnAt < WAKE_MIN_ALIVE_MS) return // 启动窗口内不判定
    if (lastDataAt !== 0 && Date.now() - lastDataAt < WAKE_STALL_MS) return // 数据正常
    if (restartCount >= WAKE_MAX_RESTARTS) {
      // 连续重启仍无数据：大概率无真实麦克风输入（如 WSL 无 RDP 会话），停止并提示
      running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      // 审计 MEDIUM（2026-08-25）：耗尽分支此前不杀仍存活的采集进程——麦克风持续被占，
      // rolloverFile 随 poll 停转永不执行，wav 无界增长（~110MB/h）
      if (child) {
        const staleProc = child
        staleProc.removeAllListeners('exit')
        staleProc.removeAllListeners('error')
        child = null
        staleProc.kill('SIGKILL')
      }
      // 审计 LOW：耗尽分支不删 wake-listen.wav——最多残留 64MB 至下次 start（对比重启分支均 rm）
      try { rmSync(wakeFile, { force: true }) } catch { /* 清理失败不影响状态提示 */ }
      opts.onStatus('唤醒采集多次重启仍无数据（可能无麦克风输入），请确认麦克风后 /voice wake off 再开启')
      return
    }
    restartCount++
    const stale = child
    stale.removeAllListeners('exit')
    stale.removeAllListeners('error')
    child = null
    ring = Buffer.alloc(0)
    lastDataAt = 0
    lastReadPos = 0
    stale.kill('SIGKILL')
    rmSync(wakeFile, { force: true })
    spawnRecorder()
  }

  return {
    async start() {
      if (running) return
      running = true
      hitCount = 0
      restartCount = 0
      rmSync(wakeFile, { force: true })
      spawnRecorder()
      opts.onStatus('🎧 唤醒监听中（说“开启语音输入”开始录音）')
      timer = setInterval(() => {
        void poll()
        guard()
      }, WAKE_POLL_MS)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      const c = child
      if (c && c.exitCode === null) {
        c.kill('SIGTERM')
        // 兜底：2s 内未退出则强杀（c 为局部快照，避免 stop() 末尾 child=null 使闭包恒空、SIGKILL 永不成死代码）
        setTimeout(() => {
          if (c && c.exitCode === null && !c.killed) c.kill('SIGKILL')
        }, 2000).unref()
      }
      running = false
      ring = Buffer.alloc(0)
      // 审计：start()/rolloverFile()/guard() 三处均 rm 采集文件，唯 stop() 漏删——
      // 长期监听后残留最后一次 wake-listen.wav（~110MB/h 增速）。此处补删（容错，
      // 失败不阻塞停止流程；下次 start() 会再清）。
      try {
        rmSync(wakeFile, { force: true })
      } catch {
        // 删除失败忽略
      }
      child = null
      return '唤醒监听已停止'
    },
    isRunning: () => running,
    hits: () => hitCount,
  }
}