/**
 * pi-voice dictation — 录音/转写状态机（对照 Myna 的 Dictation 管理层）。
 *
 * 生命周期：idle → recording → transcribing → idle
 * - 用户触发 stop 或 Node 侧定时器到点（maxSeconds）自动停止都会进入转写流程；
 *   录音进程意外退出同样进入转写（补 -q 收尾写 moov）
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
  startRecording(cfg: VoiceConfig, onExit: (code: number, stderr?: string) => void, opts?: { forceClean?: boolean }): { child: ChildProcess; file: string }
  stopRecording(cfg: VoiceConfig): Promise<CommandResult>
  /** 查询服务端录音状态（-i）：断线后区分“服务端仍在录（续录）”与“已停（异常）”。失败返回 null。 */
  queryRecording(cfg: VoiceConfig): Promise<{ isRecording: boolean } | null>
  /** 文件是否存在且 > 0 字节（区分正常录制与启动即失败/单实例占用）。 */
  fileExists(m4a: string): boolean
  convertToWav(cfg: VoiceConfig, m4a: string): Promise<{ wav: string | null; error: string }>
  transcribe(cfg: VoiceConfig, wav: string): Promise<TranscribeResult>
  deleteAudioPair(cfg: VoiceConfig, m4a: string): void
  /**
   * 等待录音文件出现且大小稳定（MediaRecorder 在进程退出后仍会写文件尾部）。
   * 返回 true = 文件就绪；false = 超时（启动即失败/单实例被占用时文件不存在或恒为 0 字节）。
   */
  waitForFileStable(m4a: string, opts?: { pollMs?: number; stableSamples?: number; maxWaitMs?: number }): Promise<boolean>
  /** 检测 wav 音量水平（转写为空时区分“未采集到声音”与“有声音但未识别”）。 */
  detectAudioLevel(wav: string): Promise<{ maxDb: number; meanDb: number } | null>
  /** 录音程序显示名（平台相关，错误提示用；如 termux-microphone-record / parec (RDPSource)） */
  micLabel: string
  /** 录音依赖安装指引（平台相关） */
  micInstallHint: string
  /** 录音权限检查指引（平台相关） */
  micPermissionHint: string
}

export interface StopResult {
  message: string
  text: string
  language: string
  /** 自动停止原因：timer = Node 定时器到点；exit = 录音进程意外退出；undefined = 手动停止。 */
  autoReason?: 'timer' | 'exit'
  /** exit 异常提前结束时的实际录音秒数（提示用）。 */
  autoSec?: number
  /** 转写进行中时 stop() 返回的提示结果（无转写内容，调用方据此不标失败）。 */
  busy?: boolean
}

export interface DictationCallbacks {
  /** 录音进程自行退出（超时）触发自动转写完成时调用（无调用方 UI 上下文）。 */
  onAutoComplete(result: StopResult): void
  /** 录音文件实际生成（麦克风真的开始录，启动延迟实测 1-2s）时调用，供 UI 把“初始化中”切换为“录音中”。 */
  onReady?(): void
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
): Promise<{ wav: string | null; error: string }> {
  let error = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await deps.convertToWav(cfg, m4a)
    if (r.wav) return { wav: r.wav, error: '' }
    error = r.error
    if (attempt < 2) await new Promise((r2) => setTimeout(r2, 1000))
  }
  return { wav: null, error }
}

export function createDictation(
  cfg: VoiceConfig,
  deps: RecordingDeps,
  cb: DictationCallbacks,
): Dictation {
  let currentFile: string | null = null
  // 停止进行中标志（审计 MEDIUM：stopInternal 置空 currentFile 后 await stopRecording
  // 有 ~3s 窗口（termux -q 往返），期间新 start 会通过检查并启动新录音，被全局 -q /
  // 模块级 activeLinuxRecorder 误停——加 stopping 拒绝窗口内启动）
  let stopping = false
  let recordingChild: ChildProcess | null = null
  let busy = false
  /** 录音代次：cancel 或新 start 都会自增，使旧进程 exit 回调的异步等待作废（不转写旧文件）。 */
  let gen = 0
  /** 本次录音是否已自动重试过（防止重试失败后无限循环）。 */
  let retried = false
  /** 当前录音进程启动时间戳：退出时计算实际录音时长（区分正常超时与异常提前退出）。 */
  let startedAt = 0
  /** Node 侧计时器：到 maxSeconds 自动停止录音（替代 MediaRecorder -l 服务端计时）。 */
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function isRecording(): boolean {
    return currentFile !== null
  }
  function isTranscribing(): boolean {
    return busy
  }

  /** 启动一次录音进程并绑定退出回调；成功返回 null 以外的 {child,file} 并设置状态。 */
  function spawnRecorder(expectGen: number, forceClean = false): { child: ChildProcess; file: string } | null {
    startedAt = Date.now()
    const { child, file } = deps.startRecording(cfg, (code, detail) => {
      // 子进程自行退出：仅当仍是当前录音且未在转写时处理（用户 stop/cancel 已先置空 currentFile，不会重复）
      if (currentFile !== file || busy) return
      if (code === 0) {
        void (async () => {
          // CLI 断线（Termux:API SocketListener EOF 是已知问题，录制本身不受影响）：
          // 先查服务端 MediaRecorder 是否仍在录制。仍在录 → 无感续录（不打断、
          // 不提示，等用户停止或 Node 定时器到点）；已停 → 走异常提前结束路径。
          const info = await deps.queryRecording(cfg)
          if (expectGen !== gen || currentFile !== file || busy) return
          const stillRecording = info?.isRecording === true && deps.fileExists(file)
          if (stillRecording) {
            // 服务端仍在录制：无感续录。进程已退出（后续 -q 仍能正常停止服务端），
            // currentFile 保持，停止/定时器路径照常工作。
            recordingChild = null
            return
          }
          currentFile = null
          recordingChild = null
          // 服务端也已停/从未录：补发 -q 强制服务收尾（moov atom），再等文件稳定
          await deps.stopRecording(cfg).catch(() => undefined)
          // 进程退出 ≠ 文件写完：MediaRecorder 仍会写入尾部（moov atom），需等大小稳定
          // 才能区分“正常超时”与“启动即失败/单实例被占用”（后者无文件或恒为 0 字节）
          // 失败判定窗口缩短到 5s：启动失败时尽快进入重试（默认 15s 会让用户等太久）
          const stable = await deps.waitForFileStable(file, { maxWaitMs: 5000 })
          // 等待期间用户 cancel / 开始了新录音：旧文件作废，静默丢弃
          if (expectGen !== gen) return
          if (stable) {
            // -l 0 后服务端不再有超时机制：进程自行退出必然是异常（服务不稳定
            // 中途停录等），一律按“异常提前结束”提示，不再误报“时长到上限”
            const actualSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
            const r = await finish(file, 'exit', actualSec)
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
              // 重试强制清理（forceClean）：上次失败说明服务侧大概率残留 MediaRecorder
              spawnRecorder(expectGen, true)
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
        })().catch((e) => console.warn('[pi-voice] 录音进程退出处理失败:', (e as Error)?.message ?? e))
      } else {
        // 启动即失败或运行中异常退出：不转写空文件，直接把失败原因反馈给 UI
        currentFile = null
        recordingChild = null
        const reason =
          code === -2
            ? `无法启动录音程序（${deps.micLabel} 缺失或不可执行）`
            : `录音进程异常退出（code ${code}${detail?.trim() ? `，${deps.micLabel} 输出：${detail.trim().slice(0, 200)}` : ''}）`
        cb.onAutoComplete({
          message: `录音启动失败：${reason}。请检查：1) ${deps.micPermissionHint} 2) 录音路径可写（当前 ${cfg.tmpDir}） 3) ${deps.micInstallHint}`,
          text: '',
          language: '',
        })
      }
    }, { forceClean })
    if (child.pid === undefined) {
      return null
    }
    currentFile = file
    recordingChild = child
    // 启动验证：spawn 成功 ≠ 服务端真在录（假成功：进程存活但文件从未生成，
    // 常见于 MediaRecorderService 刚清理完的状态错乱）。8s 后检查：进程仍存活
    // 且文件未出现 → 判定假成功 → 主动清理重试一次，仍失败则报启动失败，
    // 避免用户白录后才发现无文件。进程已退时由 exit 回调负责（-i 续录判定）。
    // 8s 依据：实测本机 MediaRecorder 文件生成延迟可达 4s（设备省电/后台限制
    // 时初始化变慢），4s 判定会把正常录音误杀。
    setTimeout(() => {
      if (expectGen !== gen || currentFile !== file) return
      if (recordingChild === null || recordingChild.exitCode != null) return
      if (deps.fileExists(file)) return
      void (async () => {
        currentFile = null
        recordingChild = null
        // 停掉服务端假状态（-q 可能无效果，但进程会被终止，exit 回调因
        // currentFile 已置 null 而忽略）
        await deps.stopRecording(cfg).catch(() => undefined)
        if (expectGen !== gen) return
        if (!retried) {
          retried = true
          // MediaRecorderService 释放慢（实测需数秒）：等 3s 再拉起，避免重试
          // 撞上未释放窗口再次假成功（此前 1s 太短，连续 3 次录音失败）
          await new Promise((r) => setTimeout(r, 3000))
          if (expectGen !== gen || currentFile !== null || busy) return
          spawnRecorder(expectGen, true)
          return
        }
        cb.onAutoComplete({
          message: '录音启动失败：服务端未实际开始录音（无音频文件生成），已自动重试仍失败。请稍候再试，或检查麦克风权限',
          text: '',
          language: '',
        })
      })()
    }, 8000)
    return { child, file }
  }

  function start(): string {
    if (busy) return '上一段仍在转写中，请稍候'
    if (stopping) return '正在停止上一段录音，请稍候再试'
    if (currentFile !== null) return '已在录音中（再按 Ctrl+Alt+R 停止）'
    gen += 1
    retried = false
    const r = spawnRecorder(gen)
    if (!r) {
      return `录音启动失败（无法启动录音程序，请确认已安装：${deps.micInstallHint}）`
    }
    // Node 侧计时到点自动停止（不依赖 MediaRecorder -l 服务端计时，见 core.startRecording）
    clearTimer()
    if (cfg.maxSeconds > 0) {
      timer = setTimeout(() => {
        timer = null
        // 自动路径（定时器触发）无调用方 UI 上下文：结果经 onAutoComplete 分发；
        // 状态机正常时 busy/未在录音不会出现（stop/cancel 已先 clearTimer），
        // stopInternal 对它们返回 null，此处不会分发。
        // 兑底 → 兜底：stopInternal 抛错（转写/转码依赖异常）必须被捕获，否则成为 unhandledRejection。
        void stopInternal(true).then((res) => {
          if (res) cb.onAutoComplete(res)
        }).catch((e) => console.warn('[pi-voice] 定时器自动停止失败:', (e as Error)?.message ?? e))
      }, cfg.maxSeconds * 1000)
    }
    // 就绪提示：文件实际生成（麦克风真在录，启动延迟实测 1-2s）时回调 onReady，
    // 供 UI 把"初始化中"切换为"录音中"——避免用户在初始化窗口说话丢开头。
    // 文件一直未出现时由假成功检测（spawnRecorder 8s 定时器）兜底，轮询自然退出
    //（currentFile 置 null 后轮询内检查退出）。
    let readyPoll: ReturnType<typeof setInterval> | null = null
    readyPoll = setInterval(() => {
      if (currentFile !== r.file) {
        if (readyPoll) {
          clearInterval(readyPoll)
          readyPoll = null
        }
        return
      }
      if (deps.fileExists(r.file)) {
        if (readyPoll) {
          clearInterval(readyPoll)
          readyPoll = null
        }
        cb.onReady?.()
      }
    }, 300)
    return '🎤 录音中（再次 Ctrl+Alt+R 停止并转写；时长上限 ' + (cfg.maxSeconds > 0 ? `${cfg.maxSeconds}s` : '不限') + '）'
  }

  /** 停止录音并转写；auto=true 为自动路径（定时器到点），结果由调用方决定分发方式。 */
  async function stopInternal(auto: boolean): Promise<StopResult | null> {
    if (busy) return null
    if (currentFile === null) return null
    stopping = true
    clearTimer()
    const file = currentFile
    currentFile = null
    recordingChild = null
    // 发 -q 停止；进程可能已自行退出，忽略失败
    await deps.stopRecording(cfg).catch(() => undefined)
    // 定时器路径 = 已到上限，actualSec 按实际计时传入（提示用）；手动路径无前缀
    try {
      return await finish(file, auto ? 'timer' : 'manual', Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    } finally {
      stopping = false
    }
  }

  function stop(): Promise<StopResult> {
    // 外部契约：busy/未在录音时返回提示消息（timer 路径无需提示，返回 null 即可）；
    // busy 用 busy 标志区分，供调用方（deliverResult）用 info 提示而非误报失败。
    return stopInternal(false).then((r) =>
      r ?? {
        message: busy ? '正在转写，请稍候' : '未在录音',
        text: '',
        language: '',
        busy: busy || undefined,
      },
    )
  }

  function cancel(): string {
    if (currentFile === null) return '未在录音'
    gen += 1
    clearTimer()
    const file = currentFile
    currentFile = null
    recordingChild = null
    void deps.stopRecording(cfg).catch(() => undefined)
    deps.deleteAudioPair(cfg, file)
    return '已取消'
  }

  async function finish(file: string, reason: 'manual' | 'timer' | 'exit', actualSec?: number): Promise<StopResult> {
    busy = true
    try {
      // -l 0 后服务端无超时机制：exit = 进程意外退出（服务不稳定中途停录），
      // 一律按异常提前结束提示；timer = Node 定时器到点，正常提示到上限
      const prefix =
        reason === 'timer'
          ? '录音时长到上限，自动开始转写：'
          : reason === 'exit'
            ? `录音异常提前结束（${actualSec ?? '?'}s），自动转写：`
            : ''
      const autoReason = reason === 'manual' ? undefined : reason
      const autoSec = reason === 'exit' ? actualSec : undefined
      // 用户手动 stop 同样存在竞态：-q 使脚本退出后 MediaRecorder 仍会写文件尾部，
      // 转码前统一等待大小稳定（exit 回调路径此时文件已稳定，立即返回）
      const stable = await deps.waitForFileStable(file)
      if (!stable) {
        // 手动停止无文件 = 服务端从未真正开始录（假成功/占用），明确提示可重试；
        // 自动路径（exit/timer）无文件 = 服务端已停但收尾异常
        const msg =
          reason === 'manual'
            ? '未生成录音文件：服务端未实际开始录音（可能启动失败或已被其他应用占用），请重试'
            : `${prefix}录音文件未生成或未写入完成（录音可能已被占用中断）`
        return { message: msg, text: '', language: '', autoReason }
      }
      const { wav, error } = await convertWithRetry(deps, cfg, file)
      if (!wav) {
        const detail = error ? `（${error}）` : ''
        return { message: `${prefix}m4a 转 wav 失败${detail}，请确认 ffmpeg 已安装`, text: '', language: '', autoReason }
      }
      const out = await deps.transcribe(cfg, wav)
      if (out.error) return { message: `${prefix}${out.error}`, text: '', language: '', autoReason }
      if (!out.text) {
        // 区分“麦克风未采到声音”与“有声音但识别失败”：音量检测失败时按后者提示
        const level = await deps.detectAudioLevel(wav)
        if (level !== null && level.maxDb < -45) {
          return {
            message: `${prefix}未检测到声音信号（最大音量 ${level.maxDb.toFixed(0)} dB），请检查麦克风权限与音量`,
            text: '',
            language: '',
            autoReason,
          }
        }
        return { message: `${prefix}未识别到语音内容，请靠近麦克风重试`, text: '', language: '', autoReason }
      }
      const final = out.text.trim()
      return {
        message: `转写完成（${out.language}）：${final}`,
        text: final,
        language: out.language,
        autoReason,
        autoSec,
      }
    } finally {
      // 即用即弃：无论成功失败，立即删除本次录音文件
      deps.deleteAudioPair(cfg, file)
      busy = false
    }
  }

  function cleanup(): void {
    clearTimer()
    recordingChild?.kill()
    recordingChild = null
    // 补 -q 优雅停止服务侧 MediaRecorder：CLI 进程断线后 termux 服务侧仍继续录制
    // （SocketListener EOF 录制不受影响），麦克风持续被占用、音频继续写入已删文件
    void deps.stopRecording(cfg).catch(() => undefined)
    if (currentFile !== null) {
      deps.deleteAudioPair(cfg, currentFile)
      currentFile = null
    }
  }

  return { start, stop, cancel, cleanup, isRecording, isTranscribing }
}