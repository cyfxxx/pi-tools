/**
 * pi-voice recording — 录音会话管理、文件操作、转码。
 * 依赖 types.ts 的 runCommand/nowStamp/CommandResult 和 platform.ts 的平台抽象。
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { VoiceConfig } from './config'
import { resolvePlatform, platformInstallGuide, type PlatformSpec } from './platform'
import { runCommand, nowStamp, type CommandResult } from './types'

/** 当前平台活跃的 linux 录音进程（startRecording 记录，stopRecording 终止；termux 平台恒为 null）。 */
let activeLinuxRecorder: { child: ChildProcess; file: string } | null = null

/** 本实例未收尾的 termux 录音会话（审计 MEDIUM 修复：多实例互杀防护门控）。
 *  startRecording 成功 spawn 置位；子进程异常退出（code≠0，服务端大概率未录）、
 *  spawn error、或 stopRecording 执行全局 -q 后作废。termux 的 -q 与残留清理
 *  pkill 作用于 Termux:API 服务侧唯一的 MediaRecorder，多实例并发会误伤其他
 *  实例的活跃录音——仅本实例自身处于活跃录音状态时才放行这些全局操作。 */
let termuxSessionActive = false

// ---- 录音会话状态文件（2026-08-28 审计：崩溃自愈的 PID 归属化） ----

function sessionStateFile(): string {
  return join(process.env.HOME ?? '/tmp', '.pi', 'agent', '.pi-voice-session.json')
}

function writeSessionOwner(): void {
  try {
    mkdirSync(dirname(sessionStateFile()), { recursive: true })
    writeFileSync(sessionStateFile(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  } catch { /* 写失败不阻塞主流程 */ }
}

function clearSessionOwner(): void {
  try { unlinkSync(sessionStateFile()) } catch { /* 忽略 */ }
}

export function ownerOrphaned(): boolean {
  try {
    const raw = readFileSync(sessionStateFile(), 'utf-8')
    const data = JSON.parse(raw) as { pid?: number }
    if (typeof data.pid !== 'number' || !Number.isFinite(data.pid)) { clearSessionOwner(); return false }
    try { process.kill(data.pid, 0); return false } catch {
      clearSessionOwner()
      return true
    }
  } catch { return false }
}

export function gpuSwitchBlockReason(kind: PlatformSpec['kind'], hasNvidiaSmi: boolean): string | null {
  if (kind === 'termux') return '当前环境无 NVIDIA GPU（安卓），仅支持 cpu / auto'
  if (kind === 'windows' || kind === 'linux') {
    return hasNvidiaSmi ? null : '未检测到 NVIDIA GPU（nvidia-smi 不可用），gpu 切换不可用。可用：cpu / auto'
  }
  return '未知平台，gpu 切换不可用。可用：cpu / auto'
}

export function platformOf(cfg: VoiceConfig): PlatformSpec {
  return resolvePlatform(cfg)
}

/**
 * 启动录音（平台相关）。
 * termux：termux-microphone-record -e aac（m4a，需 ffmpeg 转码）；后台常驻直到 stop。
 * linux：parec 直出 wav（16k 单声道 s16le = whisper 输入格式），前台进程直到 stop。
 * 返回 { child, file }：child 为录音进程，file 为音频输出路径。
 */
export function startRecording(
  cfg: VoiceConfig,
  onExit: (code: number, stderr?: string) => void,
  opts: { forceClean?: boolean } = {},
): { child: ChildProcess; file: string } {
  const spec = platformOf(cfg)
  const residue = spec.recorder.residuePattern()
  const allowResidueClean =
    residue !== null &&
    (termuxSessionActive ||
     ownerOrphaned() ||
     (spec.kind === 'linux' && opts.forceClean === true))
  let hasResidue = allowResidueClean && opts.forceClean === true
  if (allowResidueClean && !hasResidue) {
    try {
      execFileSync('pgrep', ['-f', residue])
      hasResidue = true
    } catch {
      // 无残留进程：跳过清理直接启动
    }
  }
  if (hasResidue) {
    const stopArgs = spec.recorder.stopArgs()
    if (stopArgs) {
      try {
        execFileSync(spec.recorder.bin, stopArgs, { timeout: 8000 })
      } catch {
        // 无进行中录音或 -q 失败：忽略，继续
      }
    }
    try {
      execFileSync('pkill', ['-f', residue])
    } catch {
      // 无残留进程或 pkill 不可用：忽略
    }
    try {
      execFileSync('sleep', ['1.5'])
    } catch {
      // 非 Unix 环境：忽略
    }
  }
  try {
    mkdirSync(cfg.tmpDir, { recursive: true })
  } catch (e) {
    throw new Error(`创建录音临时目录失败（tmpDir=${cfg.tmpDir}）: ${(e as Error).message}`)
  }
  const file = join(cfg.tmpDir, `pi-voice-${nowStamp()}-${Math.random().toString(36).slice(2, 8)}.${spec.recorder.ext}`)
  let args = spec.recorder.startArgs(file)
  let recBin = spec.recorder.bin
  if (spec.kind === 'linux') {
    const margin = cfg.maxSeconds > 0 ? cfg.maxSeconds + 30 : 86400
    args = [String(margin), recBin, ...args]
    recBin = 'timeout'
  }
  const stdio: ['ignore' | 'pipe', 'pipe', 'pipe'] =
    spec.kind === 'windows' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
  const child = spawn(recBin, args, { stdio })
  if (spec.kind === 'linux' || spec.kind === 'windows') {
    const prev = activeLinuxRecorder
    if (prev && prev.child.exitCode === null && prev.child.pid !== undefined) {
      try { prev.child.kill('SIGTERM') } catch { /* 已退出 */ }
    }
    activeLinuxRecorder = { child, file }
  }
  if (spec.kind === 'termux' && child.pid !== undefined) {
    termuxSessionActive = true
    writeSessionOwner()
    activeLinuxRecorder = null
  }
  let errBuf = ''
  let outBuf = ''
  child.stdout?.on('data', (d: Buffer) => {
    outBuf = (outBuf + d.toString()).slice(-500)
  })
  child.stderr?.on('data', (d: Buffer) => {
    errBuf = (errBuf + d.toString()).slice(-500)
  })
  const capture = (): string | undefined => {
    const combined = [errBuf, outBuf].map(s => s.trim()).filter(Boolean).join(' | ')
    return combined || undefined
  }
  child.on('error', () => {
    if (spec.kind === 'termux') { termuxSessionActive = false; clearSessionOwner() }
    onExit(-2, capture())
  })
  child.on('exit', (code) => {
    if (activeLinuxRecorder?.child === child) activeLinuxRecorder = null
    if (spec.kind === 'termux' && (code ?? -1) !== 0) { termuxSessionActive = false; clearSessionOwner() }
    onExit(code ?? -1, capture())
  })
  return { child, file }
}

/**
 * 检测 wav 音量水平（ffmpeg volumedetect）。转写为空时用于区分
 * "麦克风未采集到声音"与"有声音但未识别出"。解析失败返回 null。
 */
export async function detectAudioLevel(
  wavPath: string,
  ffmpegBin = 'ffmpeg',
): Promise<{ maxDb: number; meanDb: number } | null> {
  const r = await runCommand(
    ffmpegBin,
    ['-i', wavPath, '-af', 'volumedetect', '-f', 'null', 'null'],
    { timeoutMs: 30000 },
  )
  if (r.code !== 0) return null
  const maxStr = /max_volume: ([-\.\d]+) dB/.exec(r.stderr)?.[1]
  const meanStr = /mean_volume: ([-\.\d]+) dB/.exec(r.stderr)?.[1]
  const maxDb = maxStr ? parseFloat(maxStr) : NaN
  if (Number.isNaN(maxDb)) return null
  return { maxDb, meanDb: meanStr ? parseFloat(meanStr) : -Infinity }
}

/** 停止录音（平台相关）。termux：发 -q 优雅停止服务端 MediaRecorder；linux：直接终止录音进程（SIGTERM → 1s 后 SIGKILL）；windows：写 stdin 'q'（ffmpeg 优雅退出、wav header 完整，2s 超时 SIGKILL 兜底）。 */
export async function stopRecording(cfg: VoiceConfig): Promise<CommandResult> {
  const spec = platformOf(cfg)
  if (spec.kind === 'linux' || spec.kind === 'windows') {
    const rec = activeLinuxRecorder
    if (!rec || rec.child.exitCode !== null || rec.child.pid === undefined) {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (spec.kind === 'windows') {
      return await new Promise<CommandResult>((resolvePromise) => {
        const killTimer = setTimeout(() => {
          try {
            rec.child.kill('SIGKILL')
          } catch {
            // 已退出
          }
          resolvePromise({ code: 0, stdout: '', stderr: 'stdin q 超时已强制终止' })
        }, 2000)
        rec.child.once('exit', () => {
          clearTimeout(killTimer)
          resolvePromise({ code: 0, stdout: '', stderr: '' })
        })
        try {
          rec.child.stdin?.write('q')
        } catch {
          clearTimeout(killTimer)
          resolvePromise({ code: 0, stdout: '', stderr: '' })
        }
      })
    }
    return await new Promise<CommandResult>((resolvePromise) => {
      const pid = rec.child.pid as number
      const killTimer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已退出
        }
        resolvePromise({ code: 0, stdout: '', stderr: 'SIGTERM 超时已强制终止' })
      }, 1000)
      rec.child.once('exit', () => {
        clearTimeout(killTimer)
        resolvePromise({ code: 0, stdout: '', stderr: '' })
      })
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        clearTimeout(killTimer)
        resolvePromise({ code: 0, stdout: '', stderr: '' })
      }
    })
  }
  if (!termuxSessionActive && !ownerOrphaned()) {
    return { code: 0, stdout: '', stderr: '' }
  }
  termuxSessionActive = false
  const result = await runCommand(spec.recorder.bin, spec.recorder.stopArgs() ?? ['-q'], { timeoutMs: 15000 })
  clearSessionOwner()
  return result
}

/**
 * 查询当前录音状态（平台相关）。termux：termux-microphone-record -i（JSON），断线续录判定用；
 * linux：进程退出即结束、无需续录判定，返回 null（调用方按异常处理）。
 * 调用失败或解析失败返回 null。
 */
export async function queryRecording(cfg: VoiceConfig): Promise<{ isRecording: boolean } | null> {
  const spec = platformOf(cfg)
  if (spec.recorder.queryArgs() === null) return null
  const r = await runCommand(spec.recorder.bin, spec.recorder.queryArgs()!, { timeoutMs: 10000 })
  if (r.code !== 0) return null
  try {
    const data = JSON.parse(r.stdout.trim()) as { isRecording?: unknown }
    return { isRecording: data?.isRecording === true }
  } catch {
    return null
  }
}

/** 删除一次录音产出的 m4a + wav 文件（即用即弃：转写后立即清除）。 */
export function deleteAudioPair(cfg: VoiceConfig, m4a: string): void {
  for (const p of [m4a, m4a.replace(/\.m4a$/, '.wav')]) {
    try {
      rmSync(p, { force: true })
    } catch {
      // 删除失败不阻塞主流程
    }
  }
}

/** 判断录音文件是否已生成（用于区分"正常超时退出"与"启动即失败/被占用"）。 */
export function fileExists(m4a: string): boolean {
  try {
    return existsSync(m4a) && statSync(m4a).size > 0
  } catch {
    return false
  }
}

/**
 * 等待 m4a 文件出现且大小稳定。
 * termux-microphone-record（Termux:API MediaRecorder）的 bash 脚本退出（exit 0）后，
 * Android 侧仍会继续写入文件（m4a 的 moov atom 在文件尾部），立即转码会报
 * "moov atom not found"；文件也可能延迟创建（启动瞬间为 0 字节）。
 * 连续 stableSamples 次采样大小一致（且 > 0）视为写入完成。
 * 返回 true = 文件就绪；false = 超时（未创建或一直未稳定）。
 */
export async function waitForFileStable(
  m4a: string,
  opts: { pollMs?: number; stableSamples?: number; maxWaitMs?: number } = {},
): Promise<boolean> {
  const { pollMs = 300, stableSamples = 3, maxWaitMs = 15000 } = opts
  const deadline = Date.now() + maxWaitMs
  let lastSize = -1
  let stable = 0
  while (Date.now() < deadline) {
    let size = 0
    try {
      size = statSync(m4a).size
    } catch {
      size = 0
    }
    if (size > 0) {
      if (size === lastSize) {
        stable += 1
      } else {
        // 首个有效样本也计一次疑似稳定：文件已写完时无需多等一个轮询周期
        stable = lastSize === -1 ? 1 : 0
      }
      lastSize = size
      if (stable >= stableSamples) return true
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

/** 清理录音临时目录中超过 staleMs 的残留文件（默认 24h，避免误删进行中录音）。返回清理数。 */
export function cleanupStaleAudio(cfg: VoiceConfig, staleMs = 24 * 60 * 60 * 1000): number {
  let removed = 0
  let names: string[] = []
  try {
    names = readdirSync(cfg.tmpDir)
  } catch {
    return 0
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.m4a') && !name.endsWith('.wav')) continue
    const full = join(cfg.tmpDir, name)
    try {
      if (now - statSync(full).mtimeMs > staleMs) {
        rmSync(full, { force: true })
        removed += 1
      }
    } catch {
      // 文件已被删或 stat 失败，忽略
    }
  }
  return removed
}

/** 转码（平台相关）。termux：m4a → 16kHz 单声道 wav（whisper 输入格式），失败时 error 携带 ffmpeg stderr（截断）；linux：录音已直出 wav，原样返回。 */
export async function convertToWav(cfg: VoiceConfig, m4a: string): Promise<{ wav: string | null; error: string }> {
  if (!platformOf(cfg).recorder.needsConvert) return { wav: m4a, error: '' }
  const wav = m4a.replace(/\.m4a$/, '.wav')
  const res = await runCommand(cfg.ffmpegBin, [
    '-y', '-loglevel', 'error',
    '-i', m4a,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    wav,
  ], { timeoutMs: 30000 })
  if (res.code === 0) return { wav, error: '' }
  const err = res.stderr.trim() || res.stdout.trim()
  return { wav: null, error: err ? err.slice(0, 200) : `ffmpeg 退出码 ${res.code}` }
}
