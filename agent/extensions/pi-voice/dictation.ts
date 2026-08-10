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
  startRecording(cfg: VoiceConfig, onExit: (code: number, stderr?: string) => void): { child: ChildProcess; file: string }
  stopRecording(cfg: VoiceConfig): Promise<CommandResult>
  convertToWav(cfg: VoiceConfig, m4a: string): Promise<string | null>
  transcribe(cfg: VoiceConfig, wav: string): Promise<TranscribeResult>
  deleteAudioPair(cfg: VoiceConfig, m4a: string): void
  /**
   * 等待录音文件出现且大小稳定（MediaRecorder 在进程退出后仍会写文件尾部）。
   * 返回 true = 文件就绪；false = 超时（启动即失败/单实例被占用时文件不存在或恒为 0 字节）。
   */
  waitForFileStable(m4a: string): Promise<boolean>
  /** 检测 wav 音量水平（转写为空时区分“未采集到声音”与“有声音但未识别”）。 */
  detectAudioLevel(wav: string): Promise<{ maxDb: number; meanDb: number } | null>
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

/**
 * 转码带重试：MediaRecorder 在 -q/退出后仍会写 m4a 尾部（moov atom），
 * waitForFileStable 判定大小稳定后 moov 可能尚未写完，立即转码报
 * "moov atom not found"。失败后等 1s 重试（最多 3 次）兜底。
 */
async function convertWithRetry(
  deps: RecordingDeps,
  cfg: VoiceConfig,
  m4a: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wav = await deps.convertToWav(cfg, m4a)
    if (wav) return wav
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

export function createDictation(
  cfg: VoiceConfig,
  deps: RecordingDeps,
  cb: DictationCallbacks,
): Dictation {
  let currentFile: string | null = null
  let recordingChild: ChildProcess | null = null
  let busy = false
  /** 录音代次：cancel 或新 start 都会自增，使旧进程 exit 回调的异步等待作废（不转写旧文件）。 */
  let gen = 0
  /** 本次录音是否已自动重试过（防止重试失败后无限循环）。 */
  let retried = false

  function isRecording(): boolean {
    return currentFile !== null
  }
  function isTranscribing(): boolean {
    return busy
  }

  /** 启动一次录音进程并绑定退出回调；成功返回 null 以外的 {child,file} 并设置状态。 */
  function spawnRecorder(expectGen: number): { child: ChildProcess; file: string } | null {
    const { child, file } = deps.startRecording(cfg, (code, detail) => {
      // 子进程自行退出：仅当仍是当前录音且未在转写时处理（用户 stop/cancel 已先置空 currentFile，不会重复）
      if (currentFile !== file || busy) return
      currentFile = null
      recordingChild = null
      if (code === 0) {
        void (async () => {
          // 进程退出 ≠ 文件写完：MediaRecorder 仍会写入尾部（moov atom），需等大小稳定
          // 才能区分“正常超时”与“启动即失败/单实例被占用”（后者无文件或恒为 0 字节）
          const stable = await deps.waitForFileStable(file)
          // 等待期间用户 cancel / 开始了新录音：旧文件作废，静默丢弃
          if (expectGen !== gen) return
          if (stable) {
            // 正常超时（-l 到达上限）：自动进入转写
            const r = await finish(file, true)
            cb.onAutoComplete(r)
          } else {
            // 等待窗口内始终无有效文件：单实例冲突（“Recording already in progress!”，退出码恰为 0）
            // 或 MediaRecorderService 仍在收尾（写 moov atom）未释放。自动重试一次：
            // 等 2s 再拉起新进程，避免用户反复手动触发同一故障。
            if (!retried) {
              retried = true
              // MediaRecorderService 释放慢：pkill/-q 后服务侧可能仍需数秒才完全
              // 释放麦克风，立即重试会再次假成功（stdout 显示 Recording started 但
              // 无文件）。等 3s 再拉起新进程。
              await new Promise((r2) => setTimeout(r2, 3000))
              if (expectGen !== gen || currentFile !== null || busy) return
              spawnRecorder(expectGen)
              return
            }
            const detailTxt = detail?.trim() ? `（termux-api 输出：${detail.trim().slice(0, 200)}）` : ''
            const serviceAnomaly = detail?.includes('Recording started') && detail?.includes('Max Duration')
            cb.onAutoComplete({
              message: serviceAnomaly
                ? `录音启动失败：termux-api 响应异常（接受请求但未写入音频文件）${detailTxt}。已自动重试，若仍失败请稍候再试`
                : `录音启动失败：录音进程已退出且未生成音频${detailTxt}（可能已被其他录音占用）。请先执行 /voice stop 停止现有录音，或检查麦克风权限`,
              text: '',
              language: '',
            })
          }
        })()
      } else {
        // 启动即失败或运行中异常退出：不转写空文件，直接把失败原因反馈给 UI
        const reason =
          code === -2
            ? '无法启动录音程序（termux-microphone-record 缺失或不可执行）'
            : `录音进程异常退出（code ${code}${detail?.trim() ? `，termux-api 输出：${detail.trim().slice(0, 200)}` : ''}）`
        cb.onAutoComplete({
          message: `录音启动失败：${reason}。请检查：1) Android 设置 → 应用 → Termux:API → 麦克风权限 2) 录音路径可写（当前 ${cfg.tmpDir}） 3) pkg install termux-api`,
          text: '',
          language: '',
        })
      }
    })
    if (child.pid === undefined) {
      return null
    }
    currentFile = file
    recordingChild = child
    return { child, file }
  }

  function start(): string {
    if (busy) return '上一段仍在转写中，请稍候'
    if (currentFile !== null) return '已在录音中（再按 Ctrl+Alt+R 停止）'
    gen += 1
    retried = false
    const r = spawnRecorder(gen)
    if (!r) {
      return '录音启动失败（无法启动录音程序，请确认已安装 termux-api：pkg install termux-api）'
    }
    return '🎤 录音中（再次 Ctrl+Alt+R 停止并转写；时长上限 ' + (cfg.maxSeconds > 0 ? `${cfg.maxSeconds}s` : '不限') + '）'
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
    gen += 1
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
      // 用户手动 stop 同样存在竞态：-q 使脚本退出后 MediaRecorder 仍会写文件尾部，
      // 转码前统一等待大小稳定（exit 回调路径此时文件已稳定，立即返回）
      const stable = await deps.waitForFileStable(file)
      if (!stable) {
        return { message: `${prefix}录音文件未生成或未写入完成（录音可能已被占用中断）`, text: '', language: '' }
      }
      const wav = await convertWithRetry(deps, cfg, file)
      if (!wav) return { message: `${prefix}m4a 转 wav 失败，请确认 ffmpeg 已安装`, text: '', language: '' }
      const out = await deps.transcribe(cfg, wav)
      if (out.error) return { message: `${prefix}${out.error}`, text: '', language: '' }
      if (!out.text) {
        // 区分“麦克风未采到声音”与“有声音但识别失败”：音量检测失败时按后者提示
        const level = await deps.detectAudioLevel(wav)
        if (level !== null && level.maxDb < -45) {
          return {
            message: `${prefix}未检测到声音信号（最大音量 ${level.maxDb.toFixed(0)} dB），请检查麦克风权限与音量`,
            text: '',
            language: '',
          }
        }
        return { message: `${prefix}未识别到语音内容，请靠近麦克风重试`, text: '', language: '' }
      }
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