/**
 * pi-voice dictation — 录音/转写状态机（对照 Myna 的 Dictation 管理层）。
 *
 * 生命周期：idle → recording → transcribing → idle
 * - 用户触发 stop 或录音进程自行退出（maxSeconds 超时）都会进入转写流程
 * - 转写完成（含失败/异常路径）后立即删除音频文件（即用即弃）
 * - 超时自动转写时可能没有调用方 UI 上下文，结果通过 onAutoComplete 钩子处理
 * - cleanup() 用于 session_shutdown / 卸载时杀进程并清残留
 *
 * 纯逻辑模块：录音/转码/转写/删除通过依赖注入，便于 vitest 单测；不接触 pi API。
 */

import type { ChildProcess } from 'node:child_process'
import type { VoiceConfig } from './config'
import type { CommandResult, TranscribeResult } from './core'

export interface RecordingDeps {
  startRecording(cfg: VoiceConfig, onExit: (code: number) => void): { child: ChildProcess; file: string }
  stopRecording(cfg: VoiceConfig): Promise<CommandResult>
  convertToWav(cfg: VoiceConfig, m4a: string): Promise<string | null>
  transcribe(cfg: VoiceConfig, wav: string): Promise<TranscribeResult>
  deleteAudioPair(cfg: VoiceConfig, m4a: string): void
  /** 录音文件是否已生成（区分正常超时退出与启动即失败/单实例被占用）。 */
  fileExists(m4a: string): boolean
}

export interface StopResult {
  message: string
  text: string
  language: string
}

export interface DictationCallbacks {
  /** 录音进程自行退出（超时）触发自动转写完成时调用（无调用方 UI 上下文）。 */
  onAutoComplete(result: StopResult): void
}

export interface Dictation {
  start(): string
  stop(): Promise<StopResult>
  cancel(): string
  cleanup(): void
  isRecording(): boolean
  isTranscribing(): boolean
}

export function createDictation(
  cfg: VoiceConfig,
  deps: RecordingDeps,
  cb: DictationCallbacks,
): Dictation {
  let currentFile: string | null = null
  let recordingChild: ChildProcess | null = null
  let busy = false

  function isRecording(): boolean {
    return currentFile !== null
  }
  function isTranscribing(): boolean {
    return busy
  }

  function start(): string {
    if (busy) return '上一段仍在转写中，请稍候'
    if (currentFile !== null) return '已在录音中（再按 Ctrl+Shift+R 停止）'
    const { child, file } = deps.startRecording(cfg, (code) => {
      // 子进程自行退出：仅当仍是当前录音且未在转写时处理（用户 stop/cancel 已先置空 currentFile，不会重复）
      if (currentFile !== file || busy) return
      currentFile = null
      recordingChild = null
      if (code === 0) {
        if (deps.fileExists(file)) {
          // 正常超时（-l 到达上限）：自动进入转写
          void finish(file, true).then((r) => cb.onAutoComplete(r))
        } else {
          // exit 0 但无音频文件：单实例冲突（“Recording already in progress!”，退出码恰为 0）
          cb.onAutoComplete({
            message: '录音启动失败：录音进程已退出且未生成音频（可能已被其他录音占用）。请先执行 /voice stop 停止现有录音，或检查麦克风权限',
            text: '',
            language: '',
          })
        }
      } else {
        // 启动即失败或运行中异常退出：不转写空文件，直接把失败原因反馈给 UI
        const reason =
          code === -2
            ? '无法启动录音程序（termux-microphone-record 缺失或不可执行）'
            : `录音进程异常退出（code ${code}）`
        cb.onAutoComplete({
          message: `录音启动失败：${reason}。请检查：1) Android 设置 → 应用 → Termux:API → 麦克风权限 2) 录音路径可写（当前 ${cfg.tmpDir}） 3) pkg install termux-api`,
          text: '',
          language: '',
        })
      }
    })
    if (child.pid === undefined) {
      return '录音启动失败（无法启动录音程序，请确认已安装 termux-api：pkg install termux-api）'
    }
    currentFile = file
    recordingChild = child
    return '🎤 录音中（再次 Ctrl+Shift+R 停止并转写；时长上限 ' + (cfg.maxSeconds > 0 ? `${cfg.maxSeconds}s` : '不限') + '）'
  }

  async function stop(): Promise<StopResult> {
    if (busy) return { message: '正在转写，请稍候', text: '', language: '' }
    if (currentFile === null) return { message: '未在录音', text: '', language: '' }
    const file = currentFile
    currentFile = null
    recordingChild = null
    // 用户主动停止：发 -q；进程可能已自行退出，忽略失败
    await deps.stopRecording(cfg).catch(() => undefined)
    return finish(file, false)
  }

  function cancel(): string {
    if (currentFile === null) return '未在录音'
    const file = currentFile
    currentFile = null
    recordingChild = null
    void deps.stopRecording(cfg).catch(() => undefined)
    deps.deleteAudioPair(cfg, file)
    return '已取消'
  }

  async function finish(file: string, auto: boolean): Promise<StopResult> {
    busy = true
    try {
      const prefix = auto ? '录音时长到上限，自动开始转写：' : ''
      const wav = await deps.convertToWav(cfg, file)
      if (!wav) return { message: `${prefix}m4a 转 wav 失败，请确认 ffmpeg 已安装`, text: '', language: '' }
      const out = await deps.transcribe(cfg, wav)
      if (out.error) return { message: `${prefix}${out.error}`, text: '', language: '' }
      if (!out.text) return { message: '未识别到语音内容，请重试', text: '', language: '' }
      const final = out.text.trim()
      return {
        message: `转写完成（${out.language}）：${final}`,
        text: final,
        language: out.language,
      }
    } finally {
      // 即用即弃：无论成功失败，立即删除本次录音文件
      deps.deleteAudioPair(cfg, file)
      busy = false
    }
  }

  function cleanup(): void {
    recordingChild?.kill()
    recordingChild = null
    if (currentFile !== null) {
      deps.deleteAudioPair(cfg, currentFile)
      currentFile = null
    }
  }

  return { start, stop, cancel, cleanup, isRecording, isTranscribing }
}