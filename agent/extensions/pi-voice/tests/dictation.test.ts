import { describe, it, expect, vi } from 'vitest'
import { createDictation, type RecordingDeps, type DictationCallbacks, type StopResult } from '../dictation'
import type { VoiceConfig } from '../config'
import type { ChildProcess } from 'node:child_process'

const cfg = {
  whisperEndpoint: 'http://127.0.0.1:18766',
  whisperToken: '',
  platform: 'termux',
  micBin: 'termux-microphone-record',
  ffmpegBin: 'ffmpeg',
  ttsBin: 'termux-tts-speak',
  linuxMicDevice: 'RDPSource',
  linuxTtsSink: 'RDPSink',
  linuxTtsVoice: 'cmn',
  linuxTtsRate: 170,
  ttsEngine: 'auto',
  linuxPiperModel: '/opt/pi-tts/models/zh_CN-huayan-medium.onnx',
  tmpDir: '/tmp/pi-voice',
  audioDir: '/tmp/pi-voice-out',
  ttsEnabled: true,
  ttsMaxChars: 400,
  autoSend: false,
  maxSeconds: 120,
  language: '',
  whisperModel: 'base',
  whisperDevice: 'auto',
  whisperScript: '/root/.pi/scripts/pi-whisper.sh',
} satisfies VoiceConfig

const fakeChild = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess

function makeDeps(overrides: Partial<RecordingDeps> = {}): RecordingDeps {
  return {
    startRecording: vi.fn(() => ({ child: fakeChild, file: '/tmp/pi-voice/a.m4a' })),
    stopRecording: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    queryRecording: vi.fn(async () => ({ isRecording: false })),
    fileExists: vi.fn(() => true),
    convertToWav: vi.fn(async () => ({ wav: '/tmp/pi-voice-out/a.wav', error: '' })),
    transcribe: vi.fn(async () => ({ text: '你好，世界', language: 'zh', error: undefined })),
    deleteAudioPair: vi.fn(),
    waitForFileStable: vi.fn(async () => true),
    detectAudioLevel: vi.fn(async () => ({ maxDb: -20, meanDb: -30 })),
    micLabel: 'termux-microphone-record',
    micInstallHint: 'pkg install termux-api',
    micPermissionHint: 'Android 设置 → 应用 → Termux:API → 麦克风权限',
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

  it('wav 转码失败不调用 transcribe 且删除音频（提示带 ffmpeg 错误详情）', async () => {
    const deps = makeDeps({ convertToWav: vi.fn(async () => ({ wav: null, error: 'moov atom not found' })) })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(r.message).toContain('ffmpeg')
    expect(r.message).toContain('moov atom not found')
    expect(deps.deleteAudioPair).toHaveBeenCalledWith(cfg, '/tmp/pi-voice/a.m4a')
  }, 20000)

  it('wav 转码首次失败（moov 延迟写入）重试后成功', async () => {
    const deps = makeDeps({
      convertToWav: vi.fn()
        .mockResolvedValueOnce({ wav: null, error: 'moov atom not found' }) // 第一次：moov 未写完，转码失败
        .mockResolvedValueOnce({ wav: '/tmp/pi-voice-out/a.wav', error: '' }), // 重试成功
    })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('你好，世界')
    expect(deps.convertToWav).toHaveBeenCalledTimes(2)
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
  }, 15000)

  it('maxSeconds 到点自动停止并转写（Node 侧计时替代 -l 服务端超时）', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation({ ...cfg, maxSeconds: 1 }, deps, cbs)
    d.start()
    expect(d.isRecording()).toBe(true)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    }, { timeout: 4000 })
    const r = cbs.autoResults[0]
    expect(r.text).toBe('你好，世界')
    expect(r.message).toContain('转写完成')
    expect(r.autoReason).toBe('timer')
    // 定时器路径主动发 -q 停止（而非依赖服务端 -l 超时）
    expect(deps.stopRecording).toHaveBeenCalled()
    expect(d.isRecording()).toBe(false)
    expect(d.isTranscribing()).toBe(false)
  }, 6000)

  it('手动 stop 后定时器取消，不再自动转写', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation({ ...cfg, maxSeconds: 1 }, deps, cbs)
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('你好，世界')
    // 等待超过定时器窗口，确认 timer 已取消、无第二次自动转写
    await new Promise((res) => setTimeout(res, 1600))
    expect(cbs.autoResults.length).toBe(0)
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
  }, 6000)

  it('cancel 后定时器取消，不触发自动转写', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation({ ...cfg, maxSeconds: 1 }, deps, cbs)
    d.start()
    d.cancel()
    await new Promise((res) => setTimeout(res, 1600))
    expect(cbs.autoResults.length).toBe(0)
    expect(deps.transcribe).not.toHaveBeenCalled()
  }, 6000)

  it('maxSeconds=0 不设定时器（仅手动停止）', async () => {
    const deps = makeDeps()
    const cbs = makeCallbacks()
    const d = createDictation({ ...cfg, maxSeconds: 0 }, deps, cbs)
    d.start()
    await new Promise((res) => setTimeout(res, 300))
    expect(cbs.autoResults.length).toBe(0)
    const r = await d.stop()
    expect(r.text).toBe('你好，世界')
  }, 4000)

  it('进程意外提前退出：提示异常提前结束而非误报时长到上限', async () => {
    const deps = makeDeps({ transcribe: vi.fn(async () => ({ text: '', language: '', error: 'whisper 不可达' })) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    const r = cbs.autoResults[0]
    // 转写失败时 message 带前缀：必须标注“异常提前结束”而非“时长到上限”
    expect(r.message).toContain('录音异常提前结束')
    expect(r.message).not.toContain('时长到上限')
    expect(r.autoReason).toBe('exit')
  })

  it('启动失败自动重试时强制清理（forceClean）', async () => {
    const deps = makeDeps({ waitForFileStable: vi.fn(async () => false) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    expect(deps.startRecording).toHaveBeenCalledTimes(1)
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await new Promise((res) => setTimeout(res, 3300))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    // 首次无残留：forceClean=false（默认）；重试：forceClean=true
    expect(vi.mocked(deps.startRecording).mock.calls[0][2]).toEqual({ forceClean: false })
    expect(vi.mocked(deps.startRecording).mock.calls[1][2]).toEqual({ forceClean: true })
    // 收尾：第二次 exit 报占用错误，避免残留定时器
    const onExit2 = vi.mocked(deps.startRecording).mock.calls[1][1]
    onExit2(0, 'Recording already in progress!')
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
  }, 8000)

  it('CLI 断线但服务端仍在录制 → 无感续录，不提示不转写，用户停止时正常完成', async () => {
    const deps = makeDeps({ queryRecording: vi.fn(async () => ({ isRecording: true })) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    // 等待查询与判定完成
    await new Promise((res) => setTimeout(res, 50))
    // 无感续录：状态保持录音中，无自动转写，未补 -q（不打断录制）
    expect(d.isRecording()).toBe(true)
    expect(cbs.autoResults.length).toBe(0)
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(deps.stopRecording).not.toHaveBeenCalled()
    // 用户手动停止：正常转写完成（手动路径，非异常）
    const r = await d.stop()
    expect(r.text).toBe('你好，世界')
    expect(r.message).toContain('转写完成')
    expect(r.autoReason).toBeUndefined()
  })

  it('CLI 断线续录期间定时器到点 → 正常“时长到上限”转写', async () => {
    const deps = makeDeps({ queryRecording: vi.fn(async () => ({ isRecording: true })) })
    const cbs = makeCallbacks()
    const d = createDictation({ ...cfg, maxSeconds: 1 }, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    }, { timeout: 4000 })
    const r = cbs.autoResults[0]
    expect(r.text).toBe('你好，世界')
    expect(r.autoReason).toBe('timer')
    expect(d.isRecording()).toBe(false)
  }, 6000)

  it('CLI 断线且服务端已停（isRecording=false）→ 异常提前结束', async () => {
    const deps = makeDeps({ queryRecording: vi.fn(async () => ({ isRecording: false })) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].autoReason).toBe('exit')
    expect(d.isRecording()).toBe(false)
  })

  it('启动假成功（进程存活但文件未生成）→ 自动清理重试，仍失败报启动失败', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => false), // 文件从未生成（假成功）
    })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    expect(d.isRecording()).toBe(true)
    // 8s 启动验证 + 3s 释放等待 → 清理 + 重试（forceClean）
    await new Promise((res) => setTimeout(res, 11500))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.startRecording).mock.calls[1][2]).toEqual({ forceClean: true })
    expect(d.isRecording()).toBe(true)
    // 重试仍假成功（再 8s 验证）→ 报启动失败
    await new Promise((res) => setTimeout(res, 8500))
    expect(cbs.autoResults.length).toBe(1)
    expect(cbs.autoResults[0].message).toContain('启动失败')
    expect(cbs.autoResults[0].message).toContain('未实际开始录音')
    expect(d.isRecording()).toBe(false)
    expect(deps.transcribe).not.toHaveBeenCalled()
  }, 30000)

  it('手动停止无文件 → 提示服务端未实际开始录音（可重试）', async () => {
    const deps = makeDeps({
      fileExists: vi.fn(() => false),
      waitForFileStable: vi.fn(async () => false),
    })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    // 立即停止（在 4s 启动验证前）
    const r = await d.stop()
    expect(r.text).toBe('')
    expect(r.message).toContain('服务端未实际开始录音')
    expect(r.message).toContain('请重试')
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
    // 进程意外退出标记：-l 0 后服务端无超时，进程退出必然异常
    expect(cbs.autoResults[0].autoReason).toBe('exit')
    expect(cbs.autoResults[0].autoSec).toBeDefined()
    // 进程退出后补发 -q 强制服务收尾（moov atom），再等待文件稳定
    expect(deps.stopRecording).toHaveBeenCalled()
    expect(deps.waitForFileStable).toHaveBeenCalled()
    expect(cbs.autoResults[0].message).toContain('转写完成')
    expect(d.isRecording()).toBe(false)
    expect(d.isTranscribing()).toBe(false)
  })

  it('进程自行退出（-l 0 后无服务端超时）→ 一律“异常提前结束”而非“时长到上限”', async () => {
    const deps = makeDeps({ transcribe: vi.fn(async () => ({ text: '', language: '', error: 'whisper 不可达' })) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    // 模拟录音跑了 61s 后进程意外退出
    const now0 = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValueOnce(now0).mockReturnValue(now0 + 61_000)
    try {
      d.start()
      const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
      onExit(0)
      await vi.waitFor(() => {
        expect(cbs.autoResults.length).toBe(1)
      })
      expect(cbs.autoResults[0].message).toContain('录音异常提前结束（61s）')
      expect(cbs.autoResults[0].message).toContain('whisper 不可达')
      expect(d.isTranscribing()).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('录音进程提前退出（远小于上限）→ 提示异常提前结束', async () => {
    const deps = makeDeps({ transcribe: vi.fn(async () => ({ text: '', language: '', error: 'whisper 不可达' })) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    // startedAt 与 exit 时差仅 3s（< 120s 上限的 50%）→ 判为异常提前退出
    const now0 = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValueOnce(now0).mockReturnValue(now0 + 3_000)
    try {
      d.start()
      const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
      onExit(0)
      await vi.waitFor(() => {
        expect(cbs.autoResults.length).toBe(1)
      })
      expect(cbs.autoResults[0].message).toContain('录音异常提前结束')
      expect(cbs.autoResults[0].message).toContain('3s')
      expect(cbs.autoResults[0].message).toContain('whisper 不可达')
    } finally {
      spy.mockRestore()
    }
  })

  it('超时但无音频文件 → 自动重试一次后仍无文件才提示占用', async () => {
    const deps = makeDeps({ waitForFileStable: vi.fn(async () => false) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    // 第一次失败自动重试（2s 释放间隔）
    await new Promise((res) => setTimeout(res, 3300))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    // 第二次仍失败 → 报错
    const onExit2 = vi.mocked(deps.startRecording).mock.calls[1][1]
    onExit2(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].text).toBe('')
    expect(cbs.autoResults[0].message).toContain('可能已被其他录音占用')
    expect(deps.transcribe).not.toHaveBeenCalled()
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

  it('exit 0 但无音频文件（单实例被占用）→ 重试后报占用提示、不转写', async () => {
    const deps = makeDeps({ waitForFileStable: vi.fn(async () => false) })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await new Promise((res) => setTimeout(res, 3300))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    const onExit2 = vi.mocked(deps.startRecording).mock.calls[1][1]
    onExit2(0)
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

  it('空转写 + 低音量提示检查麦克风', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: '', language: '', error: undefined })),
      detectAudioLevel: vi.fn(async () => ({ maxDb: -91, meanDb: -91 }) as { maxDb: number; meanDb: number } | null),
    })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('')
    expect(r.message).toContain('未检测到声音信号')
    expect(r.message).toContain('麦克风')
  })

  it('空转写 + 有声音提示靠近重试', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: '', language: '', error: undefined })),
    })
    const d = createDictation(cfg, deps, makeCallbacks())
    d.start()
    const r = await d.stop()
    expect(r.text).toBe('')
    expect(r.message).toContain('未识别到语音内容')
    expect(deps.detectAudioLevel).toHaveBeenCalled()
  })

  it('启动失败（无文件）自动重试一次，仍失败透传 termux 详情', async () => {
    const deps = makeDeps({
      waitForFileStable: vi.fn(async () => false),
      startRecording: vi.fn(() => ({ child: fakeChild, file: '/tmp/pi-voice/a.m4a' })),
    })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    expect(deps.startRecording).toHaveBeenCalledTimes(1)
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0, 'Recording already in progress!')
    // 等待自动重试（2s 释放间隔）
    await new Promise((res) => setTimeout(res, 3300))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    expect(d.isRecording()).toBe(true)
    // 第二次仍失败 → 报错并透传 termux 输出
    const onExit2 = vi.mocked(deps.startRecording).mock.calls[1][1]
    onExit2(0, 'Recording already in progress!')
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].message).toContain('录音启动失败')
    expect(cbs.autoResults[0].message).toContain('Recording already in progress!')
    expect(d.isRecording()).toBe(false)
  })

  it('启动失败自动重试后成功 → 正常自动转写', async () => {
    const deps = makeDeps({
      waitForFileStable: vi.fn()
        .mockResolvedValueOnce(false) // 第 1 次 exit：无文件 → 失败
        .mockResolvedValueOnce(true) // 第 2 次 exit 异步块：文件稳定 → 进 finish
        .mockResolvedValue(true), // finish 内部再次确认稳定
      startRecording: vi.fn(() => ({ child: fakeChild, file: '/tmp/pi-voice/a.m4a' })),
    })
    const cbs = makeCallbacks()
    const d = createDictation(cfg, deps, cbs)
    d.start()
    const onExit = vi.mocked(deps.startRecording).mock.calls[0][1]
    onExit(0)
    await new Promise((res) => setTimeout(res, 3300))
    expect(deps.startRecording).toHaveBeenCalledTimes(2)
    const onExit2 = vi.mocked(deps.startRecording).mock.calls[1][1]
    onExit2(0)
    await vi.waitFor(() => {
      expect(cbs.autoResults.length).toBe(1)
    })
    expect(cbs.autoResults[0].text).toBe('你好，世界')
    expect(d.isRecording()).toBe(false)
  })
})
