/**
 * pi-voice config — 配置加载。
 * 读取顺序：环境变量 > ~/.pi/agent/pi-voice.json > 默认值。
 * 纯模块，不依赖 pi API，便于 vitest 独立测试。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlatformKind, TtsEngine } from './platform'

export interface VoiceConfig {
  /** whisper 转写服务地址 */
  whisperEndpoint: string
  /** whisper 服务 Bearer token（服务端 PI_WHISPER_TOKEN，空 = 不鉴权） */
  whisperToken: string
  /** 平台：auto = 启动时自动探测（termux 工具存在 → termux，否则 linux） */
  platform: PlatformKind
  /** 录音命令 */
  micBin: string
  /** ffmpeg 转码命令（termux m4a → wav；linux 直出 wav 不需要） */
  ffmpegBin: string
  /** TTS 朗读命令 */
  ttsBin: string
  /** linux 录音输入源（pulse source 名，如 RDPSource；空 = 默认源） */
  linuxMicDevice: string
  /** linux TTS 播放输出 sink（paplay --device，如 RDPSink；空 = 默认输出） */
  linuxTtsSink: string
  /** linux TTS 引擎：auto = piper 存在则用（自然中文），否则 espeak-ng */
  ttsEngine: TtsEngine
  /** linux piper 模型路径（.onnx；config 自动取同目录 .onnx.json） */
  linuxPiperModel: string
  /** linux TTS 语音（espeak-ng -v，如 cmn/zh/en） */
  linuxTtsVoice: string
  /** linux TTS 语速（espeak-ng -s，词/分钟） */
  linuxTtsRate: number
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
  /** whisper 模型名（tiny/base/small/medium/large-v3；切换需重启服务） */
  whisperModel: string
  /** whisper 推理设备：auto/cpu/cuda（auto = nvidia-smi 可用则 cuda；服务端读取） */
  whisperDevice: 'auto' | 'cpu' | 'cuda'
  /** whisper 服务管理脚本（转写前自动拉起时使用） */
  whisperScript: string
}

/** Android（Termux）上 MediaRecorder 只能打开系统可访问路径；proot 容器内路径会 open failed: ENOENT。 */
export function defaultTmpDir(): string {
  if (existsSync('/storage/emulated/0')) {
    try {
      const dir = '/storage/emulated/0/pi-voice/'
      mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      // 共享存储不可写时回退容器路径
    }
  }
  return '/tmp/pi-voice'
}

export const DEFAULTS: VoiceConfig = {
  whisperEndpoint: 'http://127.0.0.1:18766',
  whisperToken: '',
  platform: 'auto',
  micBin: 'termux-microphone-record',
  ffmpegBin: 'ffmpeg',
  ttsBin: 'termux-tts-speak',
  linuxMicDevice: 'RDPSource',
  linuxTtsSink: 'RDPSink',
  ttsEngine: 'auto',
  linuxPiperModel: '/opt/pi-tts/models/zh_CN-huayan-medium.onnx',
  linuxTtsVoice: 'cmn',
  linuxTtsRate: 170,
  tmpDir: defaultTmpDir(),
  audioDir: join(homedir(), '.pi', 'logs', 'voice'),
  ttsEnabled: false,
  ttsMaxChars: 400,
  autoSend: false,
  maxSeconds: 120,
  language: '',
  whisperModel: 'base',
  whisperDevice: 'auto',
  whisperScript: join(homedir(), '.pi', 'scripts', 'pi-whisper.sh'),
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
    platform: (env.PI_VOICE_PLATFORM ?? file.platform ?? DEFAULTS.platform) as PlatformKind,
    micBin: env.PI_VOICE_MIC_BIN || file.micBin || DEFAULTS.micBin,
    ffmpegBin: env.PI_VOICE_FFMPEG_BIN || file.ffmpegBin || DEFAULTS.ffmpegBin,
    ttsBin: env.PI_VOICE_TTS_BIN || file.ttsBin || DEFAULTS.ttsBin,
    linuxMicDevice: env.PI_VOICE_LINUX_MIC_DEVICE ?? file.linuxMicDevice ?? DEFAULTS.linuxMicDevice,
    linuxTtsSink: env.PI_VOICE_LINUX_TTS_SINK ?? file.linuxTtsSink ?? DEFAULTS.linuxTtsSink,
    ttsEngine: (env.PI_VOICE_TTS_ENGINE ?? file.ttsEngine ?? DEFAULTS.ttsEngine) as TtsEngine,
    linuxPiperModel: env.PI_VOICE_PIPER_MODEL ?? file.linuxPiperModel ?? DEFAULTS.linuxPiperModel,
    linuxTtsVoice: env.PI_VOICE_LINUX_TTS_VOICE ?? file.linuxTtsVoice ?? DEFAULTS.linuxTtsVoice,
    linuxTtsRate: numeric(env.PI_VOICE_LINUX_TTS_RATE, file.linuxTtsRate ?? DEFAULTS.linuxTtsRate),
    tmpDir: env.PI_VOICE_TMP_DIR || file.tmpDir || DEFAULTS.tmpDir,
    audioDir: file.audioDir || DEFAULTS.audioDir,
    ttsEnabled: envBool(env.PI_VOICE_TTS_ENABLED, file.ttsEnabled ?? DEFAULTS.ttsEnabled),
    ttsMaxChars: numeric(env.PI_VOICE_TTS_MAX_CHARS, file.ttsMaxChars ?? DEFAULTS.ttsMaxChars),
    autoSend: envBool(env.PI_VOICE_AUTO_SEND, file.autoSend ?? DEFAULTS.autoSend),
    maxSeconds: numeric(env.PI_VOICE_MAX_SECONDS, file.maxSeconds ?? DEFAULTS.maxSeconds),
    language: env.PI_VOICE_LANGUAGE ?? file.language ?? DEFAULTS.language,
    whisperModel: env.PI_VOICE_WHISPER_MODEL ?? file.whisperModel ?? DEFAULTS.whisperModel,
    whisperDevice: (env.PI_VOICE_WHISPER_DEVICE ?? file.whisperDevice ?? DEFAULTS.whisperDevice) as 'auto' | 'cpu' | 'cuda',
    whisperScript: env.PI_VOICE_WHISPER_SCRIPT ?? file.whisperScript ?? DEFAULTS.whisperScript,
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
    platform: 'PI_VOICE_PLATFORM',
    micBin: 'PI_VOICE_MIC_BIN',
    ffmpegBin: 'PI_VOICE_FFMPEG_BIN',
    ttsBin: 'PI_VOICE_TTS_BIN',
    linuxMicDevice: 'PI_VOICE_LINUX_MIC_DEVICE',
    linuxTtsSink: 'PI_VOICE_LINUX_TTS_SINK',
    ttsEngine: 'PI_VOICE_TTS_ENGINE',
    linuxPiperModel: 'PI_VOICE_PIPER_MODEL',
    linuxTtsVoice: 'PI_VOICE_LINUX_TTS_VOICE',
    linuxTtsRate: 'PI_VOICE_LINUX_TTS_RATE',
    ttsEnabled: 'PI_VOICE_TTS_ENABLED',
    ttsMaxChars: 'PI_VOICE_TTS_MAX_CHARS',
    autoSend: 'PI_VOICE_AUTO_SEND',
    maxSeconds: 'PI_VOICE_MAX_SECONDS',
    tmpDir: 'PI_VOICE_TMP_DIR',
    language: 'PI_VOICE_LANGUAGE',
    whisperModel: 'PI_VOICE_WHISPER_MODEL',
    whisperDevice: 'PI_VOICE_WHISPER_DEVICE',
    whisperScript: 'PI_VOICE_WHISPER_SCRIPT',
  }
  return map[key] ?? null
}
