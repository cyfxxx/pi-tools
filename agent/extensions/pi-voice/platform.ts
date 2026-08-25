/**
 * pi-voice platform — 平台适配层。
 *
 * 将录音/朗读的“平台差异”收敛为 PlatformSpec（命令构造 + 提示文案），
 * 上层（core/dictation）只消费 spec，不感知具体平台。新增设备适配时
 * 只需新增一个 spec 分支（如 macos：sox 录音 + say 朗读）。
 *
 * 平台：
 * - termux（Android）：termux-microphone-record（m4a，需 ffmpeg 转码）+ termux-tts-speak
 * - linux（桌面/WSL）：parec/arecord（wav 直出，无需转码）+ espeak-ng + paplay
 *
 * 纯模块：命令探测通过注入（默认 execFileSync which），便于 vitest 独立测试。
 */

import { execFileSync } from 'node:child_process' // 仅 defaultPlatformEnv 用
import type { VoiceConfig } from './config'

/** 配置层平台值：auto = 启动时自动探测 */
export type PlatformKind = 'auto' | 'termux' | 'linux' | 'windows'

/** 解析后的实际平台 */
export type ResolvedPlatform = 'termux' | 'linux' | 'windows'

export interface RecorderSpec {
  /** 录音命令二进制（linux 平台默认 parec，可被 cfg.micBin 覆盖） */
  bin: string
  /** 录音输出扩展名 */
  ext: 'm4a' | 'wav'
  /** m4a → wav 是否需要 ffmpeg 转码（wav 直出平台无需） */
  needsConvert: boolean
  /** 启动录音进程的命令参数（file = 输出路径） */
  startArgs(file: string): string[]
  /** 停止录音命令参数；null = 无独立停止命令（由 stopRecording 直接终止进程） */
  stopArgs(): string[] | null
  /** 查询录音状态命令参数；null = 不支持查询（进程退出即结束） */
  queryArgs(): string[] | null
  /** 残留进程识别模式（pgrep/pkill -f 用）；null = 无单实例限制无需清理 */
  residuePattern(): string | null
  /** 录音程序显示名（错误提示用） */
  micLabel: string
  /** 录音依赖安装指引（安装缺失时提示） */
  installHint: string
  /** 录音失败通用指引（含权限检查项） */
  permissionHint: string
}

export interface TtsSpec {
  /** TTS 命令二进制 */
  bin: string
  /** TTS 程序显示名 */
  label: string
  /** 引擎类型：termux 直接朗读；espeak-ng / piper 两段式（生成 wav + 播放） */
  kind: 'termux' | 'espeak-ng' | 'piper'
  /** 检查命令参数（doctor 用；null = 跳过检查） */
  checkArgs(): string[] | null
  /** 直接朗读参数（kind=termux 用；text = 清洗后的文本） */
  speakArgs(text: string): string[]
  /** 生成 wav 参数（kind=espeak-ng/piper 用；统一文本文件 → wav 文件，避免 stdin 差异） */
  synthesizeArgs(textFile: string, stageFile: string): string[]
  /** 僵尸进程清理模式（pkill -f 用） */
  zombiePatterns(): string[]
  /** 播放命令（null = TTS 直接输出到音频设备，无需独立播放） */
  playArgs(wavFile: string): string[] | null
  /** 是否先生成 wav 文件再播放（true 时 speakArgs 目标为 -w 输出文件） */
  stageToWav: boolean
}

/** linux TTS 引擎选择：auto = piper 命令存在 → piper，否则 espeak-ng */
export type TtsEngine = 'auto' | 'espeak-ng' | 'piper'

export interface PlatformSpec {
  kind: ResolvedPlatform
  /** 平台显示名（doctor/提示用） */
  label: string
  recorder: RecorderSpec
  tts: TtsSpec
  /** 麦克风状态诊断（doctor 用）：返回 null = 跳过该项 */
  micProbeArgs(): string[] | null
}

/** 命令探测环境（可注入测试）：commandExists 默认 which，platform 默认 process.platform */
export interface PlatformEnv {
  platform: NodeJS.Platform
  commandExists(name: string): boolean
}

export function defaultPlatformEnv(): PlatformEnv {
  return {
    platform: process.platform,
    commandExists: (name: string): boolean => {
      try {
        execFileSync('which', [name], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    },
  }
}

/** 自动探测实际平台：windows → windows（ffmpeg dshow）；termux 工具存在 → termux；否则 linux 系（parec/arecord 存在时给 linux spec，缺工具也能用 doctor 给出安装指引）。 */
export function detectPlatform(env: PlatformEnv = defaultPlatformEnv()): ResolvedPlatform {
  if (env.platform === 'win32') return 'windows'
  if (env.commandExists('termux-microphone-record')) return 'termux'
  return 'linux'
}

/**
 * 解析平台 spec。cfg.platform：
 * - 'auto'：探测（windows → windows；termux 工具存在 → termux；否则 linux）
 * - 'termux' / 'linux' / 'windows'：强制指定（无对应工具也返回对应 spec，由 doctor/运行时报错提示安装）
 */
export function resolvePlatform(cfg: VoiceConfig, env: PlatformEnv = defaultPlatformEnv()): PlatformSpec {
  const kind: ResolvedPlatform = cfg.platform === 'auto' ? detectPlatform(env) : cfg.platform
  if (kind === 'termux') return termuxSpec()
  if (kind === 'windows') return windowsSpec(cfg)
  return linuxSpec(cfg, env)
}

/**
 * Windows 平台 spec（2026-08-14 新增）：
 * - 录音：ffmpeg dshow（原生麦克风捕获，wav 直出）；停止 = stopRecording 写 stdin 'q'
 *   （ffmpeg 优雅退出、wav header 完整——Windows 无 SIGTERM 优雅语义，TerminateProcess 会丢尾部）
 * - TTS：PowerShell SAPI（System.Speech，中文语音包跟随系统）
 * - 转写：whisper 服务（127.0.0.1 与 WSL localhost 互通，可复用 WSL 的 whisper）
 */
function windowsSpec(cfg: VoiceConfig): PlatformSpec {
  const micBin = cfg.micBin === 'termux-microphone-record' ? 'ffmpeg' : cfg.micBin
  return {
    kind: 'windows',
    label: 'Windows',
    recorder: {
      bin: micBin,
      ext: 'wav',
      needsConvert: false,
      startArgs: (file) => {
        const args = ['-f', 'dshow', '-i', `audio=${cfg.micDevice}`]
        if (cfg.maxSeconds > 0) args.push('-t', String(cfg.maxSeconds))
        args.push('-y', file)
        return args
      },
      stopArgs: () => null,
      queryArgs: () => null,
      residuePattern: () => null,
      micLabel: `ffmpeg (dshow)${cfg.micDevice ? ` [${cfg.micDevice}]` : ''}`,
      installHint: '安装 ffmpeg（winget install ffmpeg 或 https://www.gyan.dev/ffmpeg/builds/ 下载）',
      permissionHint: 'Windows 设置 → 隐私和安全性 → 麦克风 → 允许桌面应用访问麦克风',
    },
    tts: {
      bin: 'powershell',
      label: 'Windows SAPI',
      kind: 'termux',
      checkArgs: () => null,
      speakArgs: (text) => [
        '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`,
      ],
      synthesizeArgs: () => [],
      zombiePatterns: () => [],
      playArgs: () => null,
      stageToWav: false,
    },
    micProbeArgs: () => null,
  }
}

function termuxSpec(): PlatformSpec {
  return {
    kind: 'termux',
    label: 'Termux (Android)',
    recorder: {
      bin: 'termux-microphone-record',
      ext: 'm4a',
      needsConvert: true,
      startArgs: (file) => ['-e', 'aac', '-f', file, '-l', '0'],
      stopArgs: () => ['-q'],
      queryArgs: () => ['-i'],
      residuePattern: () => 'termux-microphone-record',
      micLabel: 'termux-microphone-record',
      installHint: 'pkg install termux-api（需 Termux:API 应用 + Android 麦克风权限）',
      permissionHint: 'Android 设置 → 应用 → Termux:API → 麦克风 → 允许',
    },
    tts: {
      bin: 'termux-tts-speak',
      label: 'termux-tts-speak',
      kind: 'termux',
      checkArgs: () => ['--help'],
      speakArgs: (text) => [text],
      synthesizeArgs: () => [],
      // 审计修复：原含 'termux-api TextToSpeech'（带空格）——pkill -x 按精确进程名匹配，
      // 含空格条目永不命中恒空转，直接删除（保留 termux-tts-speak）
      zombiePatterns: () => ['termux-tts-speak'],
      playArgs: () => null,
      stageToWav: false,
    },
    micProbeArgs: () => ['-i'],
  }
}

function linuxSpec(cfg: VoiceConfig, env: PlatformEnv): PlatformSpec {
  // 录音：parec（pulseaudio-utils）优先，回退 arecord（alsa-utils）。命令探测在
  // resolvePlatform 已做，这里按配置的 micBin 是否等于默认值区分？不——micBin 是
  // 用户可覆盖的命令名，linux 分支统一用 cfg.micBin（默认 'parec'）。设备参数：
  // linuxMicDevice 为空时用 pulse 默认源（不传 --device）。
  const micBin = cfg.micBin === 'termux-microphone-record' ? 'parec' : cfg.micBin
  const ttsBin = cfg.ttsBin === 'termux-tts-speak' ? 'espeak-ng' : cfg.ttsBin
  // TTS 引擎解析：auto = piper 命令存在 → piper（自然中文），否则 espeak-ng
  const engine: 'espeak-ng' | 'piper' =
    cfg.ttsEngine === 'auto' ? (env.commandExists('piper') ? 'piper' : 'espeak-ng') : cfg.ttsEngine
  const tts: TtsSpec =
    engine === 'piper'
      ? {
          bin: ttsBin === 'espeak-ng' ? 'piper' : ttsBin,
          label: `piper (${cfg.linuxPiperModel.split('/').pop()})`,
          kind: 'piper',
          checkArgs: () => ['--help'],
          speakArgs: () => [],
          synthesizeArgs: (textFile, stageFile) => [
            '-m', cfg.linuxPiperModel,
            '-i', textFile,
            '-f', stageFile,
          ],
          zombiePatterns: () => ['piper'],
          playArgs: (wavFile) => {
            const args = ['--device', cfg.linuxTtsSink].filter(() => cfg.linuxTtsSink !== '')
            args.push(wavFile)
            return args
          },
          stageToWav: true,
        }
      : {
          bin: ttsBin,
          label: ttsBin,
          kind: 'espeak-ng',
          checkArgs: () => ['--version'],
          // 统一文本文件输入（与 piper 对齐，避免 stdin 差异）：-f 读文件
          speakArgs: () => [],
          synthesizeArgs: (textFile, stageFile) => [
            '-f', textFile, '-w', stageFile, '-v', cfg.linuxTtsVoice, '-s', String(cfg.linuxTtsRate),
          ],
          zombiePatterns: () => ['espeak-ng', 'paplay'],
          playArgs: (wavFile) => {
            const args = ['--device', cfg.linuxTtsSink].filter(() => cfg.linuxTtsSink !== '')
            args.push(wavFile)
            return args
          },
          stageToWav: true,
        }
  return {
    kind: 'linux',
    label: 'Linux (桌面/WSL)',
    recorder: {
      bin: micBin,
      ext: 'wav',
      needsConvert: false,
      // wav 直出（16k 单声道 s16le = whisper 输入格式），无需 ffmpeg 转码
      startArgs: (file) => {
        const args: string[] = []
        if (cfg.linuxMicDevice) args.push('--device', cfg.linuxMicDevice)
        args.push('--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', file)
        return args
      },
      // 无独立停止命令：stopRecording 直接终止录音进程（parec 无服务端残留概念）
      stopArgs: () => null,
      queryArgs: () => null,
      residuePattern: () => null,
      micLabel: `${micBin}${cfg.linuxMicDevice ? ` (${cfg.linuxMicDevice})` : ''}`,
      installHint: 'apt-get install pulseaudio-utils（parec）或 alsa-utils（arecord）；WSL 需 Windows 麦克风权限',
      permissionHint: 'WSL：Windows 设置 → 隐私 → 麦克风 → 允许；检查 PULSE_SERVER 与 pactl list sources',
    },
    tts,
    micProbeArgs: () => null,
  }
}

/** which 探测 piper（linuxSpec 内部用；与 PlatformEnv 解耦，走 PATH） */
function commandExistsSafe(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** TTS 暂存 wav 路径（speak 两步间用；由 speak 实现负责写入与清理） */
export const TTS_STAGE_FILE = '/tmp/pi-voice/tts-stage.wav'

/** 平台级安装指引（voiceGuideError 用）。 */
export function platformInstallGuide(spec: PlatformSpec): string {
  return `1) 录音依赖：${spec.recorder.installHint}\n2) 转写依赖：~/.pi/scripts/pi-whisper.sh start\n3) ${spec.recorder.needsConvert ? '转码依赖：apt-get install ffmpeg' : '转写格式：录音直接输出 wav，无需 ffmpeg'}`
}
