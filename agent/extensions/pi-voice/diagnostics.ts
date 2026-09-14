/**
 * pi-voice diagnostics — doctor / benchmark / benchSuggestion。
 * 高层诊断函数，依赖 recording + transcription 模块。
 */

import type { VoiceConfig } from './config'
import { platformOf } from './recording'
import { platformInstallGuide } from './platform'
import { runCommand, type CommandResult } from './types'
import {
  startRecording,
  stopRecording,
  waitForFileStable,
  fileExists,
  convertToWav,
  deleteAudioPair,
} from './recording'
import { defaultWhisperHealth, defaultSherpaHealth, transcribeByBackend } from './transcription'

/** 诊断：逐项检查录音 / 转写 / 朗读 依赖（平台相关）。 */
export async function doctor(cfg: VoiceConfig): Promise<string[]> {
  const spec = platformOf(cfg)
  const lines: string[] = []
  // 1. 录音二进制 + 权限
  const probeArgs = spec.recorder.queryArgs()
  const mic = probeArgs !== null ? await runCommand(spec.recorder.bin, probeArgs, { timeoutMs: 10000 }) : null
  if (mic === null) {
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
    const ff = await runCommand(cfg.ffmpegBin, ['-version'], { timeoutMs: 10000 })
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
  // 5. GPU 推理提示
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
  const t0 = Date.now()
  const rec = startRecording(cfg, () => {})
  const file = rec.file
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
