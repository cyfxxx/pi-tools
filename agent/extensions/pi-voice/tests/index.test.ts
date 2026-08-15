// index.ts 接线层回归：deliverResult busy 不误报失败 / TTS 关闭期间仍记录最近回复。
// 依赖模块全部 mock（dictation/core/config），只测本文件的 UI 接线逻辑。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const dictation = {
    isRecording: vi.fn(() => false),
    isTranscribing: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    cleanup: vi.fn(),
  }
  const ttsQueue = {
    enqueue: vi.fn(),
    isSpeaking: vi.fn(() => false),
    pendingCount: vi.fn(() => 0),
    flush: vi.fn(async () => {}),
  }
  const config: Record<string, unknown> = {
    ttsEnabled: false,
    autoSend: false,
    maxSeconds: 120,
    whisperEndpoint: 'http://127.0.0.1:18766',
    whisperToken: '',
    whisperModel: 'base',
    whisperDevice: 'auto',
    whisperScript: '/tmp/nonexistent-whisper.sh',
    tmpDir: '/tmp/pi-voice',
    audioDir: '/tmp/pi-voice-out',
  }
  return { dictation, ttsQueue, config }
})

vi.mock('../dictation', () => ({
  createDictation: vi.fn(() => mocks.dictation),
}))

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    loadConfig: vi.fn(() => mocks.config),
    persistConfig: vi.fn(),
  }
})

vi.mock('../core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core')>()
  return {
    ...actual,
    platformOf: vi.fn(() => ({
      kind: 'linux',
      tts: { zombiePatterns: () => [] },
      recorder: { micLabel: 'parec', installHint: 'x', permissionHint: 'x' },
    })),
    stopRecording: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    cleanupStaleAudio: vi.fn(() => 0),
    createTtsDispatcher: vi.fn(() => mocks.ttsQueue),
    speak: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  }
})

function mockCtx() {
  return {
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      pasteToEditor: vi.fn(),
      getEditorText: vi.fn(() => ''),
    },
  }
}

async function loadExt() {
  // 每个用例全新模块：index.ts 有模块级状态（lastAssistantText 等），
  // resetModules 保证用例间互不污染。
  vi.resetModules()
  const commands: Record<string, { handler?: (args: string, ctx: ReturnType<typeof mockCtx>) => unknown }> = {}
  const handlers: Record<string, (event: unknown, ctx: ReturnType<typeof mockCtx>) => unknown> = {}
  const api: Record<string, unknown> = {
    registerCommand: (name: string, opts: unknown) => { commands[name] = opts as never },
    registerShortcut: vi.fn(),
    on: (event: string, handler: unknown) => { handlers[event] = handler as never },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  }
  const { default: ext } = await import('../index.ts')
  ext(api as never)
  return { commands, handlers, api }
}

describe('deliverResult busy 分支（转写中 stop 不误报失败）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dictation.isRecording.mockReturnValue(false)
  })

  it('/voice stop 转写中返回 busy 结果 → info 通知、不标失败', async () => {
    mocks.dictation.stop.mockResolvedValue({
      message: '正在转写，请稍候',
      text: '',
      language: '',
      busy: true,
    })
    const { commands, api } = await loadExt()
    const ctx = mockCtx()
    await commands['voice'].handler?.('stop', ctx)
    expect(ctx.ui.notify).toHaveBeenCalledWith('正在转写，请稍候', 'info')
    expect(ctx.ui.notify).not.toHaveBeenCalledWith('语音转写失败', 'error')
    expect(api.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: '正在转写，请稍候' }),
    )
  })

  it('/voice stop 普通空转写结果 → 仍按失败提示（回归）', async () => {
    mocks.dictation.stop.mockResolvedValue({
      message: '未识别到语音内容，请靠近麦克风重试',
      text: '',
      language: '',
    })
    const { commands, api } = await loadExt()
    const ctx = mockCtx()
    await commands['voice'].handler?.('stop', ctx)
    expect(ctx.ui.notify).toHaveBeenCalledWith('语音转写失败', 'error')
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '未识别到语音内容，请靠近麦克风重试' }),
    )
  })
})

describe('message_end 记录最近回复（TTS 关闭期间 /voice tts speak 可朗读）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.config.ttsEnabled = false
  })

  it('TTS 关闭时 message_end 不朗读但仍记录，tts speak 缺省朗读最新回复', async () => {
    const { commands, handlers, api } = await loadExt()
    handlers['message_end'](
      {
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: '你好，欢迎使用 pi' }],
        },
      },
      mockCtx(),
    )
    // TTS 关闭：不自动朗读
    expect(mocks.ttsQueue.enqueue).not.toHaveBeenCalled()
    // /voice tts speak 无参数：朗读最近一条有效回复（修复前 lastAssistantText 未记录会提示“暂无朗读内容”）
    await commands['voice'].handler?.('tts speak', mockCtx())
    expect(mocks.ttsQueue.enqueue).toHaveBeenCalledWith('你好，欢迎使用 pi')
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '已加入朗读队列' }),
    )
  })

  it('结构化回复（不朗读内容）不记录为最近回复', async () => {
    const { commands, handlers, api } = await loadExt()
    handlers['message_end'](
      {
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: '{"summary": "x"}' }],
        },
      },
      mockCtx(),
    )
    await commands['voice'].handler?.('tts speak', mockCtx())
    expect(mocks.ttsQueue.enqueue).not.toHaveBeenCalled()
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '暂无朗读内容' }),
    )
  })
})
