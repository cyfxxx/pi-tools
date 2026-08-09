import { describe, it, expect, vi } from 'vitest'
import {
  cleanForSpeech,
  extractAssistantText,
  nowStamp,
  benchSuggestion,
  isSpeechWorthy,
  ensureWhisperService,
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
  it('默认值', () => {
    const cfg = loadConfig({})
    expect(cfg.whisperEndpoint).toBe(DEFAULTS.whisperEndpoint)
    expect(cfg.micBin).toBe('termux-microphone-record')
    expect(cfg.ttsEnabled).toBe(true)
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
    } as NodeJS.ProcessEnv)
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
