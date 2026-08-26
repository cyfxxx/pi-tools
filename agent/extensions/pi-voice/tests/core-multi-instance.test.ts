/**
 * 审计修复回归测试（多实例并发安全）：
 * 1. [MEDIUM] TTS 暂存 wav 加 -pid 后缀隔离（原固定名 tts-stage.wav 双实例互删）
 * 2. [MEDIUM] termux 全局 -q / 残留清理 pkill 仅在本实例有活跃录音会话时执行
 * 3. [LOW] wake 采集 spawn error 分支清理 500ms poll/guard 定时器
 * 4. [LOW] Windows USERPROFILE 缺失时不退化 '.' 相对路径探测
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}))

import { startRecording, stopRecording, speak, ensureWhisperService, createWakeSession, type WakeSession } from '../core'
import { DEFAULTS, type VoiceConfig } from '../config'

/** 构造 fake ChildProcess（EventEmitter + pid/kill/stdout/stderr） */
function fakeChild(pid = 999): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as unknown as { pid: number }).pid = pid
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  ;(child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn()
  ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
  ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
  return child
}

let baseTmp = ''
let termuxCfg: VoiceConfig
let linuxCfg: VoiceConfig

beforeAll(() => {
  baseTmp = mkdtempSync(join(tmpdir(), 'pi-voice-multi-'))
  termuxCfg = {
    ...DEFAULTS, platform: 'termux', micBin: 'termux-microphone-record',
    ttsBin: 'termux-tts-speak', sttBackend: 'sherpa', tmpDir: join(baseTmp, 'termux'),
  }
  linuxCfg = {
    ...DEFAULTS, platform: 'linux', micBin: 'parec', ttsBin: 'espeak-ng', ttsEngine: 'espeak-ng',
    sttBackend: 'sherpa', tmpDir: join(baseTmp, 'linux'),
  }
})

afterAll(() => {
  rmSync(baseTmp, { recursive: true, force: true })
})

beforeEach(() => {
  spawnMock.mockReset()
  execFileMock.mockReset()
  execFileSyncMock.mockReset()
})

// runCommand 走 callback 风格 execFile：默认实现直接回 ENOENT，测试内按需覆盖
function stubExecFileOk(): void {
  execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    cb(null, '', '')
  })
}

describe('审计1 [MEDIUM]：TTS 暂存 wav 加 pid 后缀隔离', () => {
  it('stage 文件名含本进程 pid（不再固定 tts-stage.wav），播放与清理同路径', async () => {
    stubExecFileOk()
    const stages: string[] = []
    execFileMock.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      if (bin === 'espeak-ng' || bin === 'paplay') stages.push(...args.filter((a) => a.endsWith('.wav')))
      cb(null, '', '')
    })
    const r = await speak(linuxCfg, '你好世界')
    expect(r.code).toBe(0)
    expect(stages.length).toBeGreaterThan(0)
    for (const s of stages) {
      expect(s).toBe(join(linuxCfg.tmpDir, `tts-stage-${process.pid}.wav`))
      expect(s.endsWith('/tts-stage.wav')).toBe(false)
    }
    // finally 清理后不存在
    expect(existsSync(join(linuxCfg.tmpDir, `tts-stage-${process.pid}.wav`))).toBe(false)
  })
})

describe('审计2 [MEDIUM]：termux 全局 -q/pkill 门控（仅本实例有活跃录音时执行）', () => {
  it('stopRecording：无本实例会话 → 跳过全局 -q（防误停其他实例录音）', async () => {
    const r = await stopRecording(termuxCfg)
    expect(r.code).toBe(0)
    expect(execFileMock).not.toHaveBeenCalled() // 未发 termux-microphone-record -q
  })

  it('startRecording：无本实例会话 + forceClean → 跳过残留清理（pgrep/-q/pkill/sleep 均不执行）', () => {
    const { child } = { child: fakeChild() }
    spawnMock.mockReturnValue(child)
    startRecording(termuxCfg, () => {}, { forceClean: true })
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('有本实例会话 + forceClean → 残留清理照常执行（-q + pkill 兜底）', () => {
    execFileSyncMock.mockImplementation(() => undefined) // pgrep/pkill/sleep 全部成功
    spawnMock.mockImplementation(() => fakeChild())
    startRecording(termuxCfg, () => {}) // 登记会话
    startRecording(termuxCfg, () => {}, { forceClean: true }) // 有会话 → 清理放行
    const calls = execFileSyncMock.mock.calls.map((c) => [c[0], c[1]])
    expect(calls).toContainEqual(['termux-microphone-record', ['-q']])
    expect(calls).toContainEqual(['pkill', ['-f', 'termux-microphone-record']])
  })

  it('stopRecording：有本实例会话 → 发全局 -q 并消费会话；再次 stop 跳过', async () => {
    spawnMock.mockReturnValue(fakeChild(4242))
    startRecording(termuxCfg, () => {})
    stubExecFileOk()
    await stopRecording(termuxCfg)
    expect(execFileMock).toHaveBeenCalledWith('termux-microphone-record', ['-q'], expect.anything(), expect.anything())
    execFileMock.mockClear()
    await stopRecording(termuxCfg) // 会话已消费
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('子进程异常退出（code≠0）→ 会话作废，后续 stopRecording 跳过 -q', async () => {
    const onExit = vi.fn()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    startRecording(termuxCfg, onExit)
    child.emit('exit', 1) // 启动失败/被占用
    expect(onExit).toHaveBeenCalledWith(1, undefined)
    stubExecFileOk()
    await stopRecording(termuxCfg)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('spawn error（如 ENOENT）→ 会话作废，后续 stopRecording 跳过 -q', async () => {
    const onExit = vi.fn()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    startRecording(termuxCfg, onExit)
    child.emit('error', new Error('spawn ENOENT'))
    expect(onExit).toHaveBeenCalledWith(-2, undefined)
    stubExecFileOk()
    await stopRecording(termuxCfg)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('审计3 [LOW]：wake spawn error 分支清理 poll/guard 定时器', () => {
  let ws: WakeSession
  afterEach(() => {
    ws?.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('采集进程 error 后定时器清零（不永久空转），状态提示启动失败', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 })))
    const statuses: string[] = []
    const child = fakeChild()
    const errorHandlers: Array<(e: unknown) => void> = []
    child.on = vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      if (ev === 'error') errorHandlers.push(cb as (e: unknown) => void)
      return child
    }) as unknown as ChildProcess['on']
    spawnMock.mockReturnValue(child)
    ws = createWakeSession({ ...linuxCfg }, { onHit: () => {}, onStatus: (s) => statuses.push(s) })
    await ws.start()
    expect(ws.isRunning()).toBe(true)
    expect(vi.getTimerCount()).toBe(1) // 500ms poll/guard interval
    errorHandlers[0](new Error('spawn parec ENOENT'))
    expect(statuses.some((s) => s.includes('启动失败'))).toBe(true)
    expect(vi.getTimerCount()).toBe(0) // 审计修复点：error 分支同步清定时器
    expect(ws.isRunning()).toBe(false)
  })
})

describe('审计4 [LOW]：Windows USERPROFILE 缺失 → 跳过 win32 探测（不用 "." 相对路径）', () => {
  const origPlatform = process.platform
  const origUserProfile = process.env.USERPROFILE
  const origCwd = process.cwd()

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    if (origUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = origUserProfile
    process.chdir(origCwd)
    vi.unstubAllGlobals()
  })

  it('USERPROFILE 缺失 + cwd 巧含 node/node.exe → 不以相对路径拉起，回退 bash 脚本', async () => {
    // cwd 内布置 node/node.exe + node/bin/check-services.js：旧代码 root='.' 会
    // existsSync 命中并以相对路径 'node/node.exe' 拉起（bug）；新代码直接跳过
    const dir = mkdtempSync(join(tmpdir(), 'pi-voice-winprobe-'))
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node', 'node.exe'), '')
    writeFileSync(join(dir, 'node', 'bin', 'check-services.js'), '')
    process.chdir(dir)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.USERPROFILE
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable') })) // health 恒 false

    const bins: string[] = []
    execFileMock.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      bins.push(bin)
      cb(Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' }))
    })
    const r = await ensureWhisperService({ ...DEFAULTS, platform: 'linux', whisperEndpoint: 'http://127.0.0.1:18766', whisperScript: '/root/.pi/scripts/pi-whisper.sh' } as VoiceConfig)
    expect(r.ok).toBe(false)
    expect(bins[0]).toBe('bash') // 回退通用 bash 路径
    expect(bins.some((b) => !b.includes('/') && !b.includes('\\') && b !== 'bash')).toBe(false) // 无相对路径探测
    rmSync(dir, { recursive: true, force: true })
  })
})
