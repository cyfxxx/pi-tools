/**
 * 唤醒采集看门狗行为测试：mock child_process.spawn + fake timers 验证
 * - ring 停滞（采集文件无增长）时自动重启 parec（spawn 再次调用）
 * - 采集文件有数据后不再重启，且 poll 发 /wake 请求
 * - 连续重启超上限后停止并报状态
 * - stop 仍正常
 *
 * 采集数据走文件（--file-format=wav 写入 tmpDir，Node 侧读文件尾部），
 * 不依赖 stdout pipe（pi 扩展沙箱下不可靠）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWakeSession, type WakeSession } from '../core'
import type { VoiceConfig } from '../config'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

interface FakeChild {
  stdout: EventEmitter
  on: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  removeAllListeners: ReturnType<typeof vi.fn>
  exitCode: number | null
  exitHandlers: Array<(code: number | null) => void>
  errorHandlers: Array<(e: unknown) => void>
}

function makeFakeChild(): FakeChild {
  const child: FakeChild = {
    stdout: new EventEmitter(),
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      if (ev === 'exit') child.exitHandlers.push(cb as (code: number | null) => void)
      if (ev === 'error') child.errorHandlers.push(cb as (e: unknown) => void)
      return child
    }),
    kill: vi.fn(() => {
      child.exitCode = 1
      child.exitHandlers.forEach((h) => h(1))
      return true
    }),
    removeAllListeners: vi.fn((ev?: string) => {
      if (ev === 'exit') child.exitHandlers = []
      if (ev === 'error') child.errorHandlers = []
      return child
    }),
    exitCode: null,
    exitHandlers: [],
    errorHandlers: [],
  }
  return child
}

const BASE: VoiceConfig = {
  whisperEndpoint: 'http://127.0.0.1:18766',
  whisperToken: '',
  platform: 'linux',
  micBin: 'termux-microphone-record',
  micDevice: '',
  ffmpegBin: 'ffmpeg',
  ttsBin: 'piper',
  linuxMicDevice: 'RDPSource',
  linuxTtsSink: '',
  ttsEngine: 'auto',
  linuxPiperModel: '',
  linuxTtsVoice: 'cmn',
  linuxTtsRate: 170,
  tmpDir: '',
  audioDir: '',
  ttsEnabled: false,
  ttsMaxChars: 400,
  autoSend: false,
  maxSeconds: 0,
  language: 'zh',
  whisperModel: 'base',
  whisperDevice: 'cpu',
  whisperScript: 'pi-whisper.sh',
  sttBackend: 'sherpa',
  autoWake: false,
  sherpaEndpoint: 'http://127.0.0.1:18768',
  sherpaToken: '',
  sherpaScript: 'pi-sherpa.sh',
}

const WAV_HEADER = Buffer.alloc(44) // 标准 wav 头（测试用占位）
let tmpDir = ''

function wakeFile(): string {
  return join(tmpDir, 'wake-listen.wav')
}

/** 写入含 wav 头的 PCM 数据（模拟 parec 文件模式采集）。 */
function writePcm(seconds: number): void {
  const body = Buffer.alloc(seconds * 16000 * 2, 1)
  writeFileSync(wakeFile(), Buffer.concat([WAV_HEADER, body]))
}

/** 写入仅 wav 头（模拟文件刚创建、数据未到）。 */
function writeHeaderOnly(): void {
  writeFileSync(wakeFile(), WAV_HEADER)
}

describe('createWakeSession 采集看门狗', () => {
  let ws: WakeSession
  let statuses: string[]
  let fetches: ReturnType<typeof vi.fn>

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wake-guard-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFakeChild())
    statuses = []
    fetches = vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetches)
    rmSync(wakeFile(), { force: true })
  })

  afterEach(() => {
    ws?.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('start 后 spawn 一次（文件模式参数）；停滞超阈值自动重启 parec；超上限停止并提示', async () => {
    ws = createWakeSession({ ...BASE, tmpDir }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // 审计修复：timeout 包装硬上限（WAKE_PAREC_TIMEOUT_S=2h）防孤儿采集无限写盘
    expect(spawnMock.mock.calls[0][0]).toBe('timeout')
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args[0]).toBe('7200')
    expect(args[1]).toBe('parec') // micBin 默认值 → parec
    expect(args).toContain('--file-format=wav') // 文件模式采集
    expect(args[args.length - 1]).toContain('wake-listen.wav')

    // 启动窗口 8s 内不重启
    vi.advanceTimersByTime(4000)
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // 无数据超过 8s 启动窗口 → 第一次重启
    vi.advanceTimersByTime(9000)
    expect(spawnMock).toHaveBeenCalledTimes(2)

    // 新进程仍无数据 → 继续重启至上限
    vi.advanceTimersByTime(9000)
    expect(spawnMock).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(9000)
    expect(spawnMock).toHaveBeenCalledTimes(4)

    // 第 5 次停滞 → 达到上限（3 次重启）→ 停止并提示
    vi.advanceTimersByTime(9000)
    expect(spawnMock).toHaveBeenCalledTimes(4)
    expect(ws.isRunning()).toBe(false)
    expect(statuses.some((s) => s.includes('多次重启仍无数据'))).toBe(true)
  })

  it('采集文件持续增长：轮询发 /wake 且看门狗不重启', async () => {
    ws = createWakeSession({ ...BASE, tmpDir }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws.start()

    // 模拟 parec 持续采集：每 500ms 追加 0.5s PCM（与 poll 同 tick 周期，先 poll 读后写入）
    const writer = setInterval(() => {
      writeFileSync(wakeFile(), Buffer.alloc(8000, 3), { flag: 'a' })
    }, 500)
    try {
      // 小步推进（每次 advance 后 await 冲刷微任务，避免 async poll 的 inFlight 在
      // 同批次内不释放——fake timers 不自动 flush 微任务）
      const step = async (ms: number): Promise<void> => {
        for (let t = 0; t < ms; t += 500) {
          vi.advanceTimersByTime(500)
          await Promise.resolve()
        }
      }
      await step(17000) // 启动窗口 8s + 数据积累期
      const urls = fetches.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes('/wake'))).toBe(true)
      expect(ws.isRunning()).toBe(true)

      // 数据持续流入（再跑 30s）→ 看门狗从不重启
      await step(30000)
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(ws.isRunning()).toBe(true)
    } finally {
      clearInterval(writer)
    }
  })

  it('重启的旧进程 exit/error 监听已移除，不会误报异常退出', async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake)
    ws = createWakeSession({ ...BASE, tmpDir }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws.start()

    vi.advanceTimersByTime(15000) // 触发重启（kill 旧进程）
    expect(fake.kill).toHaveBeenCalled()
    expect(rmSync).toBeDefined()
    // 旧进程的 exit 回调不应触发"异常退出"状态（监听已移除）
    expect(statuses.some((s) => s.includes('异常退出'))).toBe(false)
  })

  it('采集文件超上限（64MB sparse）→ 滚动重启但保持监听（审计 MEDIUM/2026-08-24）', async () => {
    const { openSync, closeSync, truncateSync } = await import('node:fs')
    const ws2 = createWakeSession({ ...BASE, tmpDir }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws2.start()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // sparse 大文件模拟采集文件超限（不占实盘）
    const f = wakeFile()
    // 先创建空文件（truncateSync 不创建新文件），再以路径扩展为 sparse 大文件
    closeSync(openSync(f, 'w'))
    truncateSync(f, 64 * 1024 * 1024 + 1)
    // 一轮 poll（timer 500ms）检测超限 → 滚动：kill 旧进程 + 删文件 + 重 spawn
    vi.advanceTimersByTime(1000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(existsSync(f)).toBe(false)
    // 仍处于监听：启动窗口（<8s，fake Date 已推进）内无额外 spawn，且无停机提示
    vi.advanceTimersByTime(6000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(statuses.some(s => s.includes('停止'))).toBe(false)
  })

  it('stop 删除采集 wav 文件（start/rollover/guard 均有 rm，stop 补齐防残留）', async () => {
    ws = createWakeSession({ ...BASE, tmpDir }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws.start() // start 先清旧文件
    writeFileSync(wakeFile(), Buffer.concat([WAV_HEADER, Buffer.alloc(16000, 2)]))
    expect(existsSync(wakeFile())).toBe(true)
    ws.stop()
    expect(existsSync(wakeFile())).toBe(false)
    // 幂等：文件已不存在时 stop 再调不报错（rmSync force 容错）
    expect(() => ws.stop()).not.toThrow()
  })
})
