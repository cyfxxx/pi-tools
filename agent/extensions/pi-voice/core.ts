/**
 * pi-voice core — 录音 / 转码 / 转写 / 朗读 的原子操作。
 * 依赖注入 execFile/spawn/fetch 便于 vitest 独立测试；不依赖 pi API。
 */

import { execFile, spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceConfig } from './config'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/** 生成唯一的文件名前缀（非时间戳，避免缓存/断言歧义；给文件名加时间戳安全）。 */
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
      const e = err as NodeJS.ErrnoException & { code?: string | number }
      if (typeof e.code === 'number') {
        resolvePromise({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' })
        return
      }
      if (e.message.includes('ENOENT')) {
        resolvePromise({ code: 127, stdout: '', stderr: `${bin}: command not found` })
        return
      }
      if (e.message.includes('ETIMEDOUT')) {
        resolvePromise({ code: 124, stdout: stdout ?? '', stderr: `timeout after ${timeoutMs}ms` })
        return
      }
      resolvePromise({ code: 1, stdout: stdout ?? '', stderr: stderr ?? e.message })
    })
  })
}

/**
 * 启动录音（Termux:API 麦克风）。
 * -e aac 输出 m4a；后台常驻直到 stop。
 * 返回 { child, file }：child 为录音进程，file 为 m4a 输出路径。
 */
export function startRecording(
  cfg: VoiceConfig,
  onExit: (code: number, stderr?: string) => void,
  opts: { forceClean?: boolean } = {},
): { child: ChildProcess; file: string } {
  // 清理残留录音：先 -q 优雅停止 Termux:API 服务侧的 MediaRecorder（pkill 杀 CLI
  // 进程不会释放服务侧麦克风占用，残留状态会让新实例报 "Recording already in
  // progress!" 并秒退），再 pkill 兜底杀 CLI 进程，最后等待服务释放。
  // 调用方已拦截进行中的录音，此处不会误杀当前会话录音。
  // termux-microphone-record 每次调用（-q/-i）需 ~3s termux-api 通信往返，正常
  // 场景（上次录音已 -q 优雅停止）无残留进程，pgrep 门控跳过整套清理可省
  // ~4.7s 启动延迟；forceClean 用于启动失败后的自动重试（此时服务侧大概率残留）。
  let hasResidue = opts.forceClean
  if (!hasResidue) {
    try {
      execFileSync('pgrep', ['-f', 'termux-microphone-record'])
      hasResidue = true
    } catch {
      // 无残留进程：跳过清理直接启动
    }
  }
  if (hasResidue) {
    try {
      execFileSync(cfg.micBin, ['-q'], { timeout: 8000 })
    } catch {
      // 无进行中录音或 -q 失败：忽略，继续
    }
    try {
      execFileSync('pkill', ['-f', 'termux-microphone-record'])
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
  const file = join(cfg.tmpDir, `pi-voice-${nowStamp()}.m4a`)
  // 时长控制由调用方（dictation）在 Node 侧 setTimeout 到点发 -q 实现：
  // MediaRecorder.setMaxDuration 基于媒体时间戳计时而非墙钟，实际停止时间与
  // 设定值偏差大（实测经常提前一半以上停止），不可依赖。
  // -l 0 = 服务端不限时（不传则 termux-api 默认 15 分钟）。
  const args = ['-e', 'aac', '-f', file, '-l', '0']
  // stdio: 同时捕获 stdout+stderr（termux-microphone-record 的错误信息如
  // "Recording already in progress!" 打到 stdout；stderr 也可能有内容），
  // 报错时可向用户展示真实原因。
  const child = spawn(cfg.micBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  child.on('exit', (code) => onExit(code ?? -1, capture()))
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

/** 停止录音并返回 m4a 文件路径；由调用方记录文件名。 */
export async function stopRecording(cfg: VoiceConfig): Promise<CommandResult> {
  return runCommand(cfg.micBin, ['-q'], { timeoutMs: 15000 })
}

/**
 * 查询 Termux:API 当前录音状态（termux-microphone-record -i，JSON）。
 * CLI 连接断线（SocketListener EOF 是 Termux:API 已知问题）时用于区分
 * “服务端仍在录制（无感续录）”与“服务端也已停止（异常结束）”。
 * 调用失败或解析失败返回 null（按异常处理）。
 */
export async function queryRecording(cfg: VoiceConfig): Promise<{ isRecording: boolean } | null> {
  const r = await runCommand(cfg.micBin, ['-i'], { timeoutMs: 10000 })
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

/** 转码 m4a → 16kHz 单声道 wav（whisper 输入格式）。失败时 error 携带 ffmpeg stderr（截断），便于定位文件损坏原因（moov 未写完等）。 */
export async function convertToWav(cfg: VoiceConfig, m4a: string): Promise<{ wav: string | null; error: string }> {
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

/** TTS 朗读（Termux 系统 TTS，支持中文）。返回命令结果。 */
export async function speak(cfg: VoiceConfig, text: string): Promise<CommandResult> {
  const clean = cleanForSpeech(text, cfg.ttsMaxChars)
  if (!clean) return { code: 0, stdout: '', stderr: '（空文本，跳过朗读）' }
  // termux-tts-speak 一次只接受一个参数，文本须作为单个 argv 传入
  return runCommand(cfg.ttsBin, [clean], { timeoutMs: 60000 })
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

/** 诊断：逐项检查录音 / 转写 / 朗读 依赖。 */
export async function doctor(cfg: VoiceConfig): Promise<string[]> {
  const lines: string[] = []
  // 1. 录音二进制 + Termux 权限（调用 -i 获取状态）
  const mic = await runCommand(cfg.micBin, ['-i'], { timeoutMs: 10000 })
  if (mic.code === 127) {
    lines.push('✗ termux-microphone-record 缺失：请运行 pkg install termux-api，并安装 Termux:API 应用')
  } else if (mic.stderr.toLowerCase().includes('permission') || mic.stderr.toLowerCase().includes('record_audio')) {
    lines.push('✗ 麦克风权限未授予：Android 设置 → 应用 → Termux:API → 麦克风 → 允许')
  } else {
    lines.push(`✓ 麦克风可用（termux-microphone-record）`)
  }
  // 2. ffmpeg
  const ff = await runCommand(cfg.ffmpegBin, ['-version'], { timeoutMs: 10000 })
  lines.push(ff.code === 0 ? '✓ ffmpeg 可用' : '✗ ffmpeg 缺失：请 apt-get install ffmpeg')
  // 3. whisper 服务（带 token，与服务端鉴权一致；否则配置 token 后必误报不可达）
  try {
    const headers: Record<string, string> = {}
    if (cfg.whisperToken) headers['Authorization'] = `Bearer ${cfg.whisperToken}`
    const res = await fetch(`${cfg.whisperEndpoint}/health`, { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      lines.push('✗ whisper 服务鉴权失败（401）：token 与 ~/.pi/scripts/pi-whisper.sh 读取的配置不一致')
    } else {
      const data = (await res.json()) as { ok?: boolean; model?: string }
      lines.push(data.ok ? `✓ whisper 服务可用（模型 ${data.model ?? ''}）` : '✓ whisper 服务运行中（模型加载中）')
    }
  } catch {
    lines.push('✗ whisper 服务不可达：请运行 ~/.pi/scripts/pi-whisper.sh start')
  }
  // 4. TTS
  const tts = await runCommand(cfg.ttsBin, ['--help'], { timeoutMs: 10000 })
  lines.push(tts.code < 200 ? '✓ TTS 命令可用' : '✓ TTS 命令可用（无 --help，运行时验证）')
  return lines
}

/** 生成可安装指引错误（供模型直接修复环境）。 */
export function voiceGuideError(detail: string): string {
  return `语音功能不可用：${detail}\n修复指引：\n1) 录音依赖：pkg install termux-api（Termux:API 应用 + Android 麦克风权限）\n2) 转写依赖：~/.pi/scripts/pi-whisper.sh start\n3) 转码依赖：apt-get install ffmpeg`
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
  const benchCfg = { ...cfg, maxSeconds: 5 }
  const t0 = Date.now()
  const rec = startRecording(benchCfg, () => {})
  const file = rec.file
  // 等待录音进程自行退出（-l 5 上限），15s 兜底
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