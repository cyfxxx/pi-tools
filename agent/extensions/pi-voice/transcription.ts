/**
 * pi-voice transcription — whisper / sherpa (SenseVoice) 服务管理与转写。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceConfig } from './config'
import { type CommandResult, runCommand, type TranscribeResult } from './types'
import { platformOf } from './recording'

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
      if (process.platform === 'win32') {
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
