/**
 * pi-voice config — 配置加载。
 * 读取顺序：环境变量 > ~/.pi/agent/pi-voice.json > 默认值。
 * 纯模块，不依赖 pi API，便于 vitest 独立测试。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface VoiceConfig {
  /** whisper 转写服务地址 */
  whisperEndpoint: string
  /** whisper 服务 Bearer token（服务端 PI_WHISPER_TOKEN，空 = 不鉴权） */
  whisperToken: string
  /** Termux 录音命令 */
  micBin: string
  /** ffmpeg 转码命令 */
  ffmpegBin: string
  /** TTS 朗读命令 */
  ttsBin: string
  /** 录音临时目录 */
  tmpDir: string
  /** 录音输出目录（wav 落盘） */
  audioDir: string
  /** 自动朗读回复开关 */
  ttsEnabled: boolean
  /** TTS 朗读文本最大字符数 */
  ttsMaxChars: number
  /** 转写后是否直接发送（false 则粘贴到输入框供确认） */
  autoSend: boolean
  /** 录音最大秒数（0 = 手动停止） */
  maxSeconds: number
  /** 转写语言（空 = 自动检测） */
  language: string
}

export const DEFAULTS: VoiceConfig = {
  whisperEndpoint: 'http://127.0.0.1:18766',
  whisperToken: '',
  micBin: 'termux-microphone-record',
  ffmpegBin: 'ffmpeg',
  ttsBin: 'termux-tts-speak',
  tmpDir: '/tmp/pi-voice',
  audioDir: join(homedir(), '.pi', 'logs', 'voice'),
  ttsEnabled: true,
  ttsMaxChars: 400,
  autoSend: false,
  maxSeconds: 120,
  language: '',
}

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'pi-voice.json')

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  let file: Partial<VoiceConfig> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    } catch {
      // 配置损坏时回退默认值
    }
  }

  const numeric = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }

  const hasEnv = (name: string): boolean => env[name] !== undefined
  const merged: VoiceConfig = {
    whisperEndpoint: env.PI_VOICE_WHISPER_ENDPOINT || file.whisperEndpoint || DEFAULTS.whisperEndpoint,
    whisperToken: env.PI_VOICE_WHISPER_TOKEN || file.whisperToken || DEFAULTS.whisperToken,
    micBin: env.PI_VOICE_MIC_BIN || file.micBin || DEFAULTS.micBin,
    ffmpegBin: env.PI_VOICE_FFMPEG_BIN || file.ffmpegBin || DEFAULTS.ffmpegBin,
    ttsBin: env.PI_VOICE_TTS_BIN || file.ttsBin || DEFAULTS.ttsBin,
    tmpDir: file.tmpDir || DEFAULTS.tmpDir,
    audioDir: file.audioDir || DEFAULTS.audioDir,
    ttsEnabled: envBool(env.PI_VOICE_TTS_ENABLED, file.ttsEnabled ?? DEFAULTS.ttsEnabled),
    ttsMaxChars: numeric(env.PI_VOICE_TTS_MAX_CHARS, file.ttsMaxChars ?? DEFAULTS.ttsMaxChars),
    autoSend: envBool(env.PI_VOICE_AUTO_SEND, file.autoSend ?? DEFAULTS.autoSend),
    maxSeconds: numeric(env.PI_VOICE_MAX_SECONDS, file.maxSeconds ?? DEFAULTS.maxSeconds),
    language: env.PI_VOICE_LANGUAGE ?? file.language ?? DEFAULTS.language,
  }
  return merged
}

/**
 * 将部分配置持久化到 ~/.pi/agent/pi-voice.json。
 * 环境变量定义的字段不会被覆盖（环境优先级更高）。
 * 返回最终落盘字段名列表。
 */
export function persistConfig(partial: Partial<VoiceConfig>, env: NodeJS.ProcessEnv = process.env): string[] {
  let file: Partial<VoiceConfig> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    } catch {
      // 覆盖损坏文件
    }
  }
  const written: string[] = []
  for (const [key, value] of Object.entries(partial) as Array<[keyof VoiceConfig, unknown]>) {
    if (value === undefined) continue
    const envName = envKeyOf(key)
    if (envName && env[envName] !== undefined) continue // 环境变量优先，不落盘
    ;(file as Record<string, unknown>)[key] = value
    written.push(key)
  }
  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
  } catch (e) {
    throw new Error(`写入配置失败: ${(e as Error).message}`)
  }
  return written
}

function envKeyOf(key: keyof VoiceConfig): string | null {
  const map: Partial<Record<keyof VoiceConfig, string>> = {
    whisperEndpoint: 'PI_VOICE_WHISPER_ENDPOINT',
    whisperToken: 'PI_VOICE_WHISPER_TOKEN',
    micBin: 'PI_VOICE_MIC_BIN',
    ffmpegBin: 'PI_VOICE_FFMPEG_BIN',
    ttsBin: 'PI_VOICE_TTS_BIN',
    ttsEnabled: 'PI_VOICE_TTS_ENABLED',
    ttsMaxChars: 'PI_VOICE_TTS_MAX_CHARS',
    autoSend: 'PI_VOICE_AUTO_SEND',
    maxSeconds: 'PI_VOICE_MAX_SECONDS',
    language: 'PI_VOICE_LANGUAGE',
  }
  return map[key] ?? null
}
