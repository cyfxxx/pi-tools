import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanForSpeech,
  extractAssistantText,
  nowStamp,
  benchSuggestion,
  isSpeechWorthy,
  ensureWhisperService,
  createTtsDispatcher,
  detectAudioLevel,
} from '../core'
import { loadConfig, DEFAULTS, type VoiceConfig } from '../config'

describe('benchSuggestion', () => {
  it('慢于实时（rtf>1）建议降级', () => {
    expect(benchSuggestion(1.5)).toContain('tiny')
  })

  it('中间档（0.5~1）给出双向建议', () => {
    const s = benchSuggestion(0.8)
    expect(s).toContain('更大模型')
    expect(s).toContain('tiny')
  })

  it('快于实时 2 倍以上（rtf<0.5）建议升档', () => {
    expect(benchSuggestion(0.3)).toContain('small')
  })

  it('边界值', () => {
    expect(benchSuggestion(1)).toContain('tiny')
    expect(benchSuggestion(0.5)).toContain('small')
    expect(benchSuggestion(1.001)).toContain('tiny')
  })
})

describe('cleanForSpeech', () => {
  it('移除代码块标记', () => {
    expect(cleanForSpeech('结论：```js\nconsole.log(1)\n``` 完毕')).toBe('结论：完毕')
  })

  it('行内代码去反引号', () => {
    expect(cleanForSpeech('运行 `npm install`')).toBe('运行 npm install')
  })

  it('链接改为纯文本', () => {
    expect(cleanForSpeech('见 [文档](https://x.dev)')).toBe('见 文档')
  })

  it('去掉标题/列表/引用标记', () => {
    expect(cleanForSpeech('# 标题\n- 项目A\n- 项目B\n> 引用')).toBe('标题 项目A 项目B 引用')
  })

  it('去粗体斜体', () => {
    expect(cleanForSpeech('**重要** 和 *斜体*')).toBe('重要 和 斜体')
  })

  it('超长截断', () => {
    const long = '啊'.repeat(500)
    const out = cleanForSpeech(long, 100)
    expect(out.length).toBeLessThanOrEqual(103)
    expect(out.endsWith('...')).toBe(true)
  })

  it('空输入返回空', () => {
    expect(cleanForSpeech('')).toBe('')
  })
})

describe('extractAssistantText', () => {
  it('字符串 content 原样返回', () => {
    expect(extractAssistantText('直接文本')).toBe('直接文本')
  })

  it('对象数组只取 text 部分', () => {
    const content = [
      { type: 'text', text: '第一段' },
      { type: 'toolCall', name: 'x' },
      { type: 'text', text: '第二段' },
    ]
    expect(extractAssistantText(content)).toBe('第一段\n第二段')
  })

  it('忽略非 text 类型', () => {
    const content = [{ type: 'thinking', thinking: '思考' }, { type: 'toolCall', id: '1' }]
    expect(extractAssistantText(content)).toBe('')
  })

  it('非数组非字符串返回空', () => {
    expect(extractAssistantText(null)).toBe('')
    expect(extractAssistantText(undefined)).toBe('')
    expect(extractAssistantText(123 as unknown)).toBe('')
  })
})

describe('nowStamp', () => {
  it('生成 YYYYMMDD_HHMMSS 格式', () => {
    expect(nowStamp()).toMatch(/^\d{8}_\d{6}$/)
  })
})

describe('loadConfig', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'pi-voice-home-'))
  // CONFIG_PATH 是模块级常量（import 时求值），stubEnv 无法影响；显式注入
  // fakeHome 下不存在的配置路径，保证 loadConfig 只依赖 DEFAULTS 与环境变量
  const fakeCfgPath = join(fakeHome, '.pi', 'agent', 'pi-voice.json')
  it('默认值', () => {
    const cfg = loadConfig({}, fakeCfgPath)
    expect(cfg.whisperEndpoint).toBe(DEFAULTS.whisperEndpoint)
    expect(cfg.micBin).toBe('termux-microphone-record')
    expect(cfg.ttsEnabled).toBe(false)
    expect(cfg.autoSend).toBe(false)
    expect(cfg.maxSeconds).toBe(120)
  })

  it('环境变量覆盖', () => {
    const cfg = loadConfig({
      PI_VOICE_WHISPER_ENDPOINT: 'http://127.0.0.1:9999',
      PI_VOICE_MIC_BIN: 'my-mic',
      PI_VOICE_TTS_ENABLED: '0',
      PI_VOICE_AUTO_SEND: '1',
      PI_VOICE_MAX_SECONDS: '30',
    } as NodeJS.ProcessEnv, fakeCfgPath)
    expect(cfg.whisperEndpoint).toBe('http://127.0.0.1:9999')
    expect(cfg.micBin).toBe('my-mic')
    expect(cfg.ttsEnabled).toBe(false)
    expect(cfg.autoSend).toBe(true)
    expect(cfg.maxSeconds).toBe(30)
  })
})

describe('isSpeechWorthy', () => {
  it('正常文本值得朗读', () => {
    expect(isSpeechWorthy('已修复完成')).toBe(true)
    expect(isSpeechWorthy('a')).toBe(false)
  })

  it('JSON/结构化摘要不朗读', () => {
    expect(isSpeechWorthy('{"summary":{"title":"x"}}')).toBe(false)
    expect(isSpeechWorthy('[1,2,3]')).toBe(false)
    expect(isSpeechWorthy('{"decisions":[]}')).toBe(false)
  })

  it('纯符号/空白不朗读', () => {
    expect(isSpeechWorthy('---')).toBe(false)
    expect(isSpeechWorthy('```')).toBe(false)
    expect(isSpeechWorthy('**')).toBe(false)
    expect(isSpeechWorthy('  \t ')).toBe(false)
  })
})

describe('createTtsDispatcher', () => {
  it('串行：同一时刻只有一条在朗读，前一条完成后才读下一条', async () => {
    const spoken: string[] = []
    let gate!: () => void
    const gateP = new Promise<void>((r) => { gate = r })
    const d = createTtsDispatcher({
      speakFn: async (text) => {
        spoken.push(text)
        if (text === '第一条') await gateP
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    d.enqueue('第一条')
    // 等第一条真正开始朗读（挂在 gate 上）
    await vi.waitFor(() => expect(d.isSpeaking()).toBe(true))
    expect(d.pendingCount()).toBe(0)
    // 第一条朗读期间入队第二条：排队而非并发
    d.enqueue('第二条')
    expect(d.isSpeaking()).toBe(true)
    gate()
    await d.flush()
    expect(d.isSpeaking()).toBe(false)
    expect(d.pendingCount()).toBe(0)
    expect(spoken).toEqual(['第一条', '第二条'])
  })

  it('合并：新文本替换旧的待读，中间内容不朗读', async () => {
    const spoken: string[] = []
    let gate!: () => void
    const gateP = new Promise<void>((r) => { gate = r })
    const d = createTtsDispatcher({
      speakFn: async (text) => {
        spoken.push(text)
        if (text === '第一条') await gateP
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    d.enqueue('第一条')
    await vi.waitFor(() => expect(d.isSpeaking()).toBe(true))
    d.enqueue('第二条')
    d.enqueue('第三条')
    // 第二条尚未开始朗读即被第三条替换
    expect(d.pendingCount()).toBe(1)
    gate()
    await d.flush()
    expect(spoken).toEqual(['第一条', '第三条'])
  })

  it('朗读失败回调 onError 不吞错', async () => {
    const errors: string[] = []
    const d = createTtsDispatcher({
      speakFn: async () => ({ code: 1, stdout: '', stderr: 'engine down' }),
      onError: (m) => errors.push(m),
    })
    d.enqueue('会失败')
    await d.flush()
    expect(errors).toEqual(['engine down'])
  })

  it('speakFn 抛异常也回调 onError 且队列继续', async () => {
    const errors: string[] = []
    const spoken: string[] = []
    const d = createTtsDispatcher({
      speakFn: async (text) => {
        if (text === '抛错') throw new Error('boom')
        spoken.push(text)
        return { code: 0, stdout: '', stderr: '' }
      },
      onError: (m) => errors.push(m),
    })
    d.enqueue('抛错')
    await vi.waitFor(() => expect(errors.length).toBe(1))
    d.enqueue('正常')
    await d.flush()
    expect(errors).toEqual(['boom'])
    expect(spoken).toEqual(['正常'])
  })
})

describe('ensureWhisperService', () => {
  const cfg = {
    whisperEndpoint: 'http://127.0.0.1:18766',
    whisperToken: 'tok',
    whisperScript: '/root/.pi/scripts/pi-whisper.sh',
  } as VoiceConfig

  it('服务在线直接返回 ok，不触发拉起', async () => {
    const start = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
    const r = await ensureWhisperService(cfg, { health: async () => true, start })
    expect(r).toEqual({ ok: true })
    expect(start).not.toHaveBeenCalled()
  })

  it('离线且拉起成功 → 轮询等待就绪', async () => {
    let healthy = false
    const start = vi.fn(async () => { healthy = true; return { code: 0, stdout: '', stderr: '' } })
    const r = await ensureWhisperService(cfg, {
      health: async () => healthy,
      start,
      pollIntervalMs: 1,
      pollTimeoutMs: 500,
    })
    expect(r).toEqual({ ok: true })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('拉起命令失败 → 返回含指引的错误', async () => {
    const r = await ensureWhisperService(cfg, {
      health: async () => false,
      start: async () => ({ code: 127, stdout: '', stderr: 'bash: not found' }),
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    })
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toContain('自动启动失败')
  })

  it('拉起后仍不可达 → 超时报错', async () => {
    const r = await ensureWhisperService(cfg, {
      health: async () => false,
      start: async () => ({ code: 0, stdout: '', stderr: '' }),
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    })
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.error).toContain('仍不可达')
  })
})

describe('detectAudioLevel（真实 ffmpeg 集成）', () => {
  const hasFfmpeg = (() => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  const genWav = (filter: string): string => {
    const wav = join(tmpdir(), `pi-voice-level-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
    // 必须限制时长：anullsrc 等源无 duration 会无限生成直到磁盘耗尽
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', filter, '-t', '1', '-ar', '16000', '-ac', '1', wav], { stdio: 'ignore', timeout: 30000 })
    return wav
  }

  it.runIf(hasFfmpeg)('有声音频音量高于阈值', async () => {
    const wav = genWav('sine=frequency=440:duration=1')
    try {
      const lv = await detectAudioLevel(wav)
      expect(lv).not.toBeNull()
      expect(lv!.maxDb).toBeGreaterThan(-45)
    } finally {
      if (existsSync(wav)) rmSync(wav)
    }
  })

  it.runIf(hasFfmpeg)('静音音频判定为无信号', async () => {
    const wav = genWav('anullsrc=r=16000:cl=mono')
    try {
      const lv = await detectAudioLevel(wav)
      expect(lv).not.toBeNull()
      expect(lv!.maxDb).toBeLessThan(-45)
    } finally {
      if (existsSync(wav)) rmSync(wav)
    }
  })

  it.runIf(hasFfmpeg)('不存在文件返回 null', async () => {
    const lv = await detectAudioLevel('/tmp/pi-voice-does-not-exist.wav')
    expect(lv).toBeNull()
  })
})
