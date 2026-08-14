/**
 * pi-voice core — 录音 / 转码 / 转写 / 朗读 的原子操作。
 * 依赖注入 execFile/spawn/fetch 便于 vitest 独立测试；不依赖 pi API。
 */

import { execFile, spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
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
      // message 不含 ETIMEDOUT——按 killed/signal 判定超时（否则误报 code 1）
      if (e.killed === true || e.signal === 'SIGTERM') {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? e.message })
    })
  })
}

/** 当前平台活跃的 linux 录音进程（startRecording 记录，stopRecording 终止；termux 平台恒为 null）。 */
let activeLinuxRecorder: { child: ChildProcess; file: string } | null = null

/** 获取平台 spec（每次解析，探测开销毫秒级可忽略）。 */
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
  let hasResidue = opts.forceClean && residue !== null
  if (residue !== null && !hasResidue) {
    try {
      execFileSync('pgrep', ['-f', residue])
      hasResidue = true
    } catch {
      // 无残留进程：跳过清理直接启动
    }
  }
  if (hasResidue && residue !== null) {
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
  mkdirSync(cfg.tmpDir, { recursive: true })
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
  if (spec.kind === 'linux' || spec.kind === 'windows') activeLinuxRecorder = { child, file }
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
  child.on('error', () => onExit(-2, capture()))
  child.on('exit', (code) => {
    if (activeLinuxRecorder?.child === child) activeLinuxRecorder = null
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

export async function ensureWhisperService(
  cfg: VoiceConfig,
  deps: EnsureWhisperDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    health = defaultWhisperHealth(cfg),
    start = () => runCommand('bash', [cfg.whisperScript, 'start'], { timeoutMs: 30000 }),
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
  const stage = join(cfg.tmpDir, TTS_STAGE_FILE.split('/').pop()!)
  // 统一文本文件输入（espeak-ng -f / piper -i），避免 stdin 与特殊字符差异
  const textFile = join(cfg.tmpDir, 'tts-input.txt')
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
    lines.push(`✓ 麦克风可用（${spec.recorder.micLabel}）`)
  }
  // 2. ffmpeg（仅 termux 需要；linux 直出 wav）
  if (spec.recorder.needsConvert) {
    const ff = await runCommand(cfg.ffmpegBin, ['-version'], { timeoutMs: 10000 })
    lines.push(ff.code === 0 ? '✓ ffmpeg 可用' : '✗ ffmpeg 缺失：请 apt-get install ffmpeg')
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
  const r = await transcribe(cfg, wav)
  const transcribeMs = Date.now() - t1
  deleteAudioPair(cfg, file)
  if (r.error) return { lines: [`✗ 转写失败：${r.error}`], rtf: null }
  const audioSec = recordedMs / 1000
  const rtf = transcribeMs / 1000 / audioSec
  const lines = [
    `模型：${cfg.whisperModel}`,
    `音频：${audioSec.toFixed(1)}s；转写耗时：${(transcribeMs / 1000).toFixed(1)}s`,
    `实时率 RTF：${rtf.toFixed(2)}（${rtf <= 1 ? '快于实时' : '慢于实时'}）`,
    `建议：${benchSuggestion(rtf)}`,
  ]
  return { lines, rtf }
}