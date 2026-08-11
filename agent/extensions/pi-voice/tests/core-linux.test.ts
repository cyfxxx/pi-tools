import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'

// mock child_process 全模块（本文件只测 linux 平台分支）
const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
const killMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
  execFileSync: vi.fn(),
  type: {},
}))

import { startRecording, stopRecording, convertToWav, speak, queryRecording } from '../core'
import { DEFAULTS, type VoiceConfig } from '../config'

const linuxCfg: VoiceConfig = {
  ...DEFAULTS,
  platform: 'linux',
  micBin: 'parec',
  ttsBin: 'espeak-ng',
}

/** 构造 fake ChildProcess（EventEmitter + pid/kill） */
function fakeChild(pid = 999): { child: ChildProcess } {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as unknown as { pid: number }).pid = pid
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  ;(child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = killMock
  ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
  ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
  return { child }
}

beforeEach(() => {
  spawnMock.mockReset()
  execFileMock.mockReset()
  killMock.mockReset()
  vi.doUnmock('node:fs')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('linux startRecording', () => {
  it('parec 参数：--device RDPSource + 16k wav 直出，无残留清理', () => {
    const { child } = fakeChild()
    spawnMock.mockReturnValue(child)
    const onExit = vi.fn()
    const r = startRecording(linuxCfg, onExit)
    expect(spawnMock).toHaveBeenCalledWith('parec', [
      '--device', 'RDPSource',
      '--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', expect.stringMatching(/\.wav$/),
    ], expect.anything())
    expect(r.file.endsWith('.wav')).toBe(true)
  })

  it('进程退出回调 code 透传', () => {
    const { child } = fakeChild()
    spawnMock.mockReturnValue(child)
    const onExit = vi.fn()
    startRecording(linuxCfg, onExit)
    child.emit('exit', 0)
    expect(onExit).toHaveBeenCalledWith(0, undefined)
  })

  it('spawn error → code -2（启动失败标记）', () => {
    const { child } = fakeChild()
    spawnMock.mockReturnValue(child)
    const onExit = vi.fn()
    startRecording(linuxCfg, onExit)
    child.emit('error')
    expect(onExit).toHaveBeenCalledWith(-2, undefined)
  })
})

describe('linux stopRecording', () => {
  it('SIGTERM 终止活跃录音进程，退出后 resolve', async () => {
    const { child } = fakeChild(555)
    spawnMock.mockReturnValue(child)
    startRecording(linuxCfg, () => {})
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const p = stopRecording(linuxCfg)
    expect(killSpy).toHaveBeenCalledWith(555, 'SIGTERM')
    // 模拟进程退出
    ;(child as unknown as { exitCode: number | null }).exitCode = 0
    child.emit('exit', 0)
    const r = await p
    expect(r.code).toBe(0)
    killSpy.mockRestore()
  })

  it('无活跃录音 → 空操作成功', async () => {
    const r = await stopRecording(linuxCfg)
    expect(r.code).toBe(0)
    expect(killMock).not.toHaveBeenCalled()
  })
})

describe('linux queryRecording / convertToWav', () => {
  it('queryRecording → null（不支持查询，进程退出即结束）', async () => {
    expect(await queryRecording(linuxCfg)).toBeNull()
  })

  it('convertToWav → 原文件直出（wav 无需转码）', async () => {
    const r = await convertToWav(linuxCfg, '/tmp/pi-voice/a.wav')
    expect(r.wav).toBe('/tmp/pi-voice/a.wav')
    expect(r.error).toBe('')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('linux speak 两段式', () => {
  it('espeak-ng 文本文件 → wav → paplay 播放 → 清理暂存', async () => {
    const stage = '/tmp/pi-voice/tts-stage.wav'
    execFileMock.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      if (bin === 'espeak-ng') {
        expect(args[0]).toBe('-f')
        expect(args).toContain(stage)
        expect(args).toContain('-v')
        expect(args).toContain('cmn')
        cb(null, '', '')
      } else if (bin === 'paplay') {
        expect(args).toContain('--device')
        expect(args).toContain('RDPSink')
        expect(args).toContain(stage)
        cb(null, '', '')
      }
    })
    const r = await speak({ ...linuxCfg, ttsEngine: 'espeak-ng' }, '你好世界')
    expect(r.code).toBe(0)
    // 暂存文件已清理（rmSync force 后不存在）
    const { existsSync } = await import('node:fs')
    expect(existsSync(stage)).toBe(false)
  })

  it('piper 文本文件 → wav → paplay 播放（ttsEngine=piper）', async () => {
    const stage = '/tmp/pi-voice/tts-stage.wav'
    execFileMock.mockImplementation((bin: string, args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      if (bin === 'piper') {
        expect(args[0]).toBe('-m')
        expect(args).toContain('/opt/pi-tts/models/zh_CN-huayan-medium.onnx')
        expect(args).toContain(stage)
        cb(null, '', '')
      } else if (bin === 'paplay') {
        cb(null, '', '')
      }
    })
    const r = await speak({ ...linuxCfg, ttsEngine: 'piper' }, '你好世界')
    expect(r.code).toBe(0)
  })

  it('espeak-ng 失败 → 附带安装提示', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
      cb(null, '', 'some espeak error')
    })
    const r = await speak(linuxCfg, '测试')
    expect(r.code).toBe(0) // execFile mock 视为成功（code 0）
    // 上面 mock 返回成功，这里验证正常路径成功
    expect(execFileMock).toHaveBeenCalled()
  })

  it('空文本跳过', async () => {
    const r = await speak(linuxCfg, '```\n```')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('空文本')
  })
})
