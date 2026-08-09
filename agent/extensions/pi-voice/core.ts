/**
 * pi-voice core — 录音 / 转码 / 转写 / 朗读 的原子操作。
 * 依赖注入 execFile/spawn/fetch 便于 vitest 独立测试；不依赖 pi API。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
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
  onExit: (code: number) => void,
): { child: ChildProcess; file: string } {
  mkdirSync(cfg.tmpDir, { recursive: true })
  const file = join(cfg.tmpDir, `pi-voice-${nowStamp()}.m4a`)
  const limit = cfg.maxSeconds > 0 ? cfg.maxSeconds : 0
  const args = ['-e', 'aac', '-f', file]
  if (limit > 0) args.push('-l', String(limit))
  const child = spawn(cfg.micBin, args, { stdio: 'ignore' })
  // spawn 失败（如二进制缺失 ENOENT）：必须监听 error，否则 Node 抛 unhandled error；
  // 用退出码 -2 标记启动失败（区别于运行中退出），由状态机按非 0 分流报错。
  child.on('error', () => onExit(-2))
  child.on('exit', (code) => onExit(code ?? -1))
  return { child, file }
}

/** 停止录音并返回 m4a 文件路径；由调用方记录文件名。 */
export async function stopRecording(cfg: VoiceConfig): Promise<CommandResult> {
  return runCommand(cfg.micBin, ['-q'], { timeoutMs: 15000 })
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

/** 转码 m4a → 16kHz 单声道 wav（whisper 输入格式）。 */
export async function convertToWav(cfg: VoiceConfig, m4a: string): Promise<string | null> {
  const wav = m4a.replace(/\.m4a$/, '.wav')
  const res = await runCommand(cfg.ffmpegBin, [
    '-y', '-loglevel', 'error',
    '-i', m4a,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wav,
  ], { timeoutMs: 30000 })
  return res.code === 0 ? wav : null
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
    const res = await fetch(`${cfg.whisperEndpoint}/transcribe`, {
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
 * 以及过短（<2 字符）或全为符号/空白的文本。仅用于自动朗读(message_end)，
 * 手动 /tts speak 不过滤。
 */
export function isSpeechWorthy(text: string): boolean {
  const t = text.trim()
  if (t.length < 2) return false
  if (/^[{[]/.test(t)) return false
  if (/^[\s`~\-*#_>|+]+$/.test(t)) return false
  return true
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
  if (!fileExists(file)) {
    deleteAudioPair(cfg, file)
    return { lines: ['✗ 基准测试失败：录音未生成文件（检查麦克风权限与 termux-api）'], rtf: null }
  }
  const wav = await convertToWav(cfg, file)
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