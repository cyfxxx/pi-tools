import { describe, it, expect, vi } from 'vitest'
import { createDictation, type RecordingDeps, type DictationCallbacks, type StopResult } from '../dictation'
import type { VoiceConfig } from '../config'
import type { ChildProcess } from 'node:child_process'

const cfg = {
  whisperEndpoint: 'http://127.0.0.1:18766',
  whisperToken: '',
  micBin: 'termux-microphone-record',
  ffmpegBin: 'ffmpeg',
  ttsBin: 'termux-tts-speak',
  tmpDir: '/tmp/pi-voice',
  audioDir: '/tmp/pi-voice-out',
  ttsEnabled: true,
  ttsMaxChars: 400,
  autoSend: false,
  maxSeconds: 120,
  language: '',
  whisperModel: 'base',
  whisperScript: '/root/.pi/scripts/pi-whisper.sh',
} satisfies VoiceConfig

const fakeChild = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess

function makeDeps(overrides: Partial<RecordingDeps> = {}): RecordingDeps {
  return {
    startRecording: vi.fn(() => ({ child: fakeChild, file: '/tmp/pi-voice/a.m4a' })),
    stopRecording: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    convertToWav: vi.fn(async () => '/tmp/pi-voice-out/a.wav'),
    transcribe: vi.fn(async () => ({ text: '你好，世界', language: 'zh', error: undefined })),
    deleteAudioPair: vi.fn(),
    fileExists: vi.fn(() => true),
    ...overrides,
  }
}

function makeCallbacks(): DictationCallbacks & { autoResults: Array<StopResult> } {
  const autoResults: Array<StopResult> = []
  return {
    autoResults,
    onAutoComplete: (r) => { autoResults.push(r) },
  }
}

describe('dictation 状态机', () => {
  it('start 进入录音，重复 start 不重复启动', () => {
    const deps = makeDeps()
    const d = createDictation(cfg, deps, makeCallbacks())
    const m1 = d.start()
    expect(d.isRecording()).toBe(true)
    expect(deps.startRecording).toHaveBeenCalledTimes(1)
    const m2 = d.start()
    expect(m2).toContain('已在录音')
    expect(deps.startRecording).toHaveBeenCalledTimes(1)
  })

  it('stop 走 转码→转写→删除音频（即用即弃）', async () => {
    const deps = makeDeps()
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('你好，世界')
    expect(r.language).toBe('zh')
    expect(deps.convertToWav).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
    expect(deps.transcribe).toHaveBeenCalledWith(cfg, '/tmp/pi-voice-out/a.wav')
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
    expect(d.isRecording()).toBe(false)
    expect(d.isTranscribing()).toBe(false)
  })

  it('stop 时未在录音返回提示', async () => {
    const deps = makeDeps()
    const d = createDictation(cfg, deps, makeCallbacks())
    const r = await d.stop()
    expect(r.message).toContain('未在录音')
    expect(r.text).toBe('')
  })

  it('转写失败也删除音频并报错', async () => {
    const deps = makeDeps({ transcribe: vi.fn(async () => ({ text: '', language: '', error: 'whisper 不可达' })) })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('')
    expect(r.message).toContain('whisper 不可达')
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
  })

  it('wav 转码失败不调用 transcribe 且删除音频', async () => {
    const deps = makeDeps({ convertToWav: vi.fn(async () => null) })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(r.message).toContain('ffmpeg')
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
  })

  it('录音进程自行退出（超时）触发自动转写并回调', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    expect(typeof onExit).toBe('function')
    onExit(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].text).toBe('你好，世界')
    expect(d.isRecording()).toBe(false)
    expect(d.isTranscribing()).toBe(false)
  })

  it('进程启动即失败（非零退出）→ 回调失败消息、不转写、状态回 idle', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(1)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].text).toBe('')
    expect(cbs.autoResults[0].message).toContain('录音启动失败')
    expect(cbs.autoResults[0].message).toContain('code 1')
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(d.isRecording()).toBe(false)
    expect(d.isTranscribing()).toBe(false)
  })

  it('spawn 失败（-2）→ 回调含安装指引', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(-2)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].message).toContain('termux-microphone-record')
    expect(deps.transcribe).not.toHaveBeenCalled()
  })

  it('exit 0 但无音频文件（单实例被占用）→ 报占用提示、不转写', async () => {
    const deps = makeDeps({ fileExists: vi.fn(() => false) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].text).toBe('')
    expect(cbs.autoResults[0].message).toContain('已退出且未生成音频')
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(d.isRecording()).toBe(false)
  })

  it('cancel 丢弃音频不转写', async () => {
    const deps = makeDeps()
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const m = d.cancel()
    expect(m).toContain('已取消')
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(d.isRecording()).toBe(false)
  })

  it('cleanup 杀掉录音进程并删除文件', () => {
    const deps = makeDeps()
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    d.cleanup()
    expect(fakeChild.kill).toHaveBeenCalled()
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
    expect(d.isRecording()).toBe(false)
  })

  it('转写期间 stop 返回忙提示', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const deps = makeDeps({
      transcribe: vi.fn(async () => {
        await gate
        return { text: '慢速转写', language: 'zh', error: undefined }
      }),
    })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const p = d.stop()
    await vi.waitFor(() => {
      expect(d.isTranscribing()).toBe(true)
    })
    const busy = await d.stop()
    expect(busy.message).toContain('转写')
    release()
    await p
  })
})
