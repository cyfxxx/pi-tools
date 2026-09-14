/**
 * pi-voice tts — TTS 朗读、文本清洗、调度器。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceConfig } from './config'
import { platformOf } from './recording'
import { runCommand, type CommandResult } from './types'

/** TTS 朗读（平台相关）。termux：termux-tts-speak 单参数；linux：合成引擎（espeak-ng/piper）生成 wav → paplay 播放 → 清理暂存。 */
export async function speak(cfg: VoiceConfig, text: string): Promise<CommandResult> {
  const clean = cleanForSpeech(text, cfg.ttsMaxChars)
  if (!clean) return { code: 0, stdout: '', stderr: '（空文本，跳过朗读）' }
  const spec = platformOf(cfg)
  if (spec.kind === 'termux' || spec.tts.kind === 'termux') {
    return runCommand(spec.tts.bin, spec.tts.speakArgs(clean), { timeoutMs: 60000 })
  }
  mkdirSync(cfg.tmpDir, { recursive: true })
  const TTS_STAGE_FILE = 'tts-stage.wav'
  const stage = join(
    cfg.tmpDir,
    TTS_STAGE_FILE.split('/').pop()!.replace(/\.wav$/, `-${process.pid}.wav`),
  )
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
