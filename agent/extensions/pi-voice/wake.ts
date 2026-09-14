/**
 * pi-voice wake — KWS 唤醒监听（/voice wake，Linux 平台）。
 * Termux 录音 API 无实时 PCM 流（MediaRecorder 仅 aac/amr），无法持续监听；
 * Linux（parec 直出 s16le 到 stdout）可直接流式采音 → POST sherpa 服务 /wake 检测。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceConfig } from './config'
import { platformOf } from './recording'

const WAKE_RING_MS = 3000 // 环形缓冲保留最近 3s 音频
const WAKE_UPLOAD_MS = 2500 // 每次检测上传最近 2.5s
const WAKE_POLL_MS = 500 // 检测间隔
// 采集停滞看门狗：WSLg 的 RDP 麦克风源会挂起长时间未活动 client 的 stream（新建 stream
// 正常、常驻 stream 无数据），导致 ring 恒空、poll 永不发请求。连续 N ms 无新数据则
// 重启 parec（kill+respawn 会拿到新 stream）；连续重启仍无数据说明无真实输入，停止并提示。
const WAKE_STALL_MS = 8000 // ring 停滞判定阈值
const WAKE_MIN_ALIVE_MS = 8000 // spawn 后 8s 内不判定（启动窗口，与停滞阈值同长，避免重启后紧接着再判定）
const WAKE_MAX_RESTARTS = 3 // 连续停滞重启上限
const WAKE_FILE_MAX_BYTES = 64 * 1024 * 1024 // 采集 wav 文件上限（~35min）；超限滚动重启，防无限增长
// 审计修复（2026-08-26）：唤醒采集进程用 coreutils timeout 包装硬上限（比听写路径
// maxSeconds+30s 更大裕量）。裕量须远大于滚动重启周期（~35min）与停滞重启窗口，
// 正常运行永不触达；仅在 Node 崩溃后孤儿 parec 场景生效，限制其无限占麦写盘。
const WAKE_PAREC_TIMEOUT_S = 2 * 60 * 60
const WAV_HEADER_LEN = 44 // 标准 PCM wav 头长度（parec --file-format=wav 直出）
// 采集走文件而非 stdout：pi 扩展沙箱下 spawn 的 stdout 被替换为 IPC socket，长时间
// 流式数据不达（实测 0 字节），而文件模式（dictation 同款参数）稳定可靠。

/** 唤醒监听器：持续从麦克风采 PCM，轮询 sherpa 服务 /wake 检测唤醒词。 */
export interface WakeSession {
  start(): Promise<void>
  stop(): string
  isRunning(): boolean
  hits(): number
}

export interface WakeOptions {
  onHit: (keyword: string) => void
  onStatus: (status: string) => void
}

/** 构造唤醒会话；非 linux 平台直接抛错（带原因）。需 cfg.sttBackend===sherpa。 */
export function createWakeSession(cfg: VoiceConfig, opts: WakeOptions): WakeSession {
  const spec = platformOf(cfg)
  if (spec.kind !== 'linux') {
    throw new Error('唤醒监听仅支持 Linux 平台（Termux 录音 API 无实时 PCM 流；Windows 暂未支持）')
  }

  let child: ChildProcess | null = null
  let ring: Buffer = Buffer.alloc(0)
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let hitCount = 0
  let inFlight = false
  let lastDataAt = 0 // 最近一次收到 PCM 的时间（0 = 从未）
  let spawnAt = 0 // 当前 parec 的 spawn 时间
  let restartCount = 0 // 连续停滞重启次数（拿到数据后清零）
  let lastReadPos = 0 // wakeFile 已读取字节偏移（跳过 wav 头）
  const wakeFile = join(cfg.tmpDir, 'wake-listen.wav')

  const appender = (buf: Buffer): void => {
    lastDataAt = Date.now()
    restartCount = 0 // 有数据流入即认为采集健康
    ring = Buffer.concat([ring, buf])
    const cap = WAKE_RING_MS * 16 * 2 // 16kHz×2字节×秒数 = 3s≈96KB
    if (ring.length > cap) ring = ring.subarray(ring.length - cap)
  }

  // 从采集文件读取新增字节（poll 前调用）。首读只定位到数据区起点（跳过 wav 头）。
  const fileRead = (): void => {
    try {
      const st = statSync(wakeFile)
      if (st.size <= WAV_HEADER_LEN) return
      if (lastReadPos === 0) {
        lastReadPos = WAV_HEADER_LEN
        return
      }
      if (st.size <= lastReadPos) return
      const fd = openSync(wakeFile, 'r')
      try {
        const len = Math.min(st.size - lastReadPos, 64 * 1024)
        const b = Buffer.alloc(len)
        const n = readSync(fd, b, 0, len, lastReadPos)
        if (n > 0) {
          lastReadPos += n
          appender(b.subarray(0, n))
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // 文件暂不存在/不可读：静默，等下一轮（重启流程删除文件后窗口期属正常）
    }
  }

  const poll = async (): Promise<void> => {
    if (!running || inFlight) return
    fileRead()
    try {
      if (statSync(wakeFile).size > WAKE_FILE_MAX_BYTES) {
        rolloverFile()
        return
      }
    } catch { /* 文件暂不可读：下轮再判 */ }
    if (ring.length < 16000) return // 不足 1s 不上传，避免反复空检测
    const upLen = WAKE_UPLOAD_MS * 16 * 2
    const seg = ring.length > upLen ? ring.subarray(ring.length - upLen) : ring
    inFlight = true
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
      if (cfg.sherpaToken) headers['Authorization'] = `Bearer ${cfg.sherpaToken}`
      const res = await fetch(`${cfg.sherpaEndpoint}/wake`, {
        method: 'POST',
        headers,
        body: new Uint8Array(seg),
        signal: AbortSignal.timeout(6000),
      })
      if (res.ok) {
        const data = (await res.json()) as { hits?: string[] }
        if (data.hits && data.hits.length > 0) {
          hitCount += data.hits.length
          opts.onHit(data.hits[0])
          ring = Buffer.alloc(0) // 命中后清空，避免同一词重复触发
        }
      }
    } catch {
      // 服务临时不可达：静默跳过本轮，下轮重试
    } finally {
      inFlight = false
    }
  }

  // spawn parec 采集进程（start 与看门狗重启共用）。采集写入 wav 文件（pi 扩展沙箱
  // 下 stdout pipe 不可靠——实测 IPC socket 化后流式数据不达），Node 侧周期读文件尾部。
  const spawnRecorder = (): void => {
    const args: string[] = []
    if (cfg.linuxMicDevice) args.push('--device', cfg.linuxMicDevice)
    args.push('--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', wakeFile)
    const parecBin = cfg.micBin === 'termux-microphone-record' ? 'parec' : cfg.micBin
    child = spawn('timeout', [String(WAKE_PAREC_TIMEOUT_S), parecBin, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    spawnAt = Date.now()
    lastReadPos = 0
    child.on('error', (e) => {
      running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      opts.onStatus(`唤醒监听启动失败：${(e as Error).message}`)
    })
    child.on('exit', (code) => {
      if (running) {
        running = false
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        opts.onStatus(code === 0 ? '唤醒监听已停止' : `唤醒监听异常退出（${code ?? '?'}）`)
      }
    })
  }

  // 采集文件滚动重启（审计 MEDIUM/2026-08-24）：wav 只读尾不截断，长时间监听
  // 文件无界增长（16kHz×2B≈31KB/s≈110MB/h）。文件超上限时滚动采集进程让文件有界
  // （数据健康滚动，不计数停滞重启）。
  const rolloverFile = (): void => {
    if (!child) return
    const stale = child
    stale.removeAllListeners('exit')
    stale.removeAllListeners('error')
    child = null
    ring = Buffer.alloc(0)
    lastDataAt = 0
    lastReadPos = 0
    // SIGTERM 先杀 timeout（转发到 parec 优雅退出）；500ms 兕底强杀本体
    stale.kill('SIGTERM')
    setTimeout(() => {
      try {
        if (stale.exitCode === null) stale.kill('SIGKILL')
      } catch { /* 已退出 */ }
    }, 500).unref()
    rmSync(wakeFile, { force: true })
    spawnRecorder()
  }

  // 采集停滞看门狗：parec 存活但长时间无数据 → 判定 stream 挂起，重启采集进程。
  const guard = (): void => {
    if (!running || !child || child.exitCode !== null) return
    if (Date.now() - spawnAt < WAKE_MIN_ALIVE_MS) return // 启动窗口内不判定
    if (lastDataAt !== 0 && Date.now() - lastDataAt < WAKE_STALL_MS) return // 数据正常
    if (restartCount >= WAKE_MAX_RESTARTS) {
      running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (child) {
        const staleProc = child
        staleProc.removeAllListeners('exit')
        staleProc.removeAllListeners('error')
        child = null
        staleProc.kill('SIGTERM')
        setTimeout(() => {
          try {
            if (staleProc.exitCode === null) staleProc.kill('SIGKILL')
          } catch { /* 已退出 */ }
        }, 500).unref()
      }
      try { rmSync(wakeFile, { force: true }) } catch { /* 清理失败不影响状态提示 */ }
      opts.onStatus('唤醒采集多次重启仍无数据（可能无麦克风输入），请确认麦克风后 /voice wake off 再开启')
      return
    }
    restartCount++
    const stale = child
    stale.removeAllListeners('exit')
    stale.removeAllListeners('error')
    child = null
    ring = Buffer.alloc(0)
    lastDataAt = 0
    lastReadPos = 0
    stale.kill('SIGTERM')
    setTimeout(() => {
      try {
        if (stale.exitCode === null) stale.kill('SIGKILL')
      } catch { /* 已退出 */ }
    }, 500).unref()
    rmSync(wakeFile, { force: true })
    spawnRecorder()
  }

  return {
    async start() {
      if (running) return
      running = true
      hitCount = 0
      restartCount = 0
      rmSync(wakeFile, { force: true })
      spawnRecorder()
      opts.onStatus('🎧 唤醒监听中（说"开启语音输入"开始录音）')
      timer = setInterval(() => {
        void poll()
        guard()
      }, WAKE_POLL_MS)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      const c = child
      if (c && c.exitCode === null) {
        c.kill('SIGTERM')
        setTimeout(() => {
          if (c && c.exitCode === null && !c.killed) c.kill('SIGKILL')
        }, 2000).unref()
      }
      running = false
      ring = Buffer.alloc(0)
      try {
        rmSync(wakeFile, { force: true })
      } catch {
        // 删除失败忽略
      }
      child = null
      return '唤醒监听已停止'
    },
    isRunning: () => running,
    hits: () => hitCount,
  }
}
