import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'pi-voice-home-'))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('HOME', fakeHome)
  vi.stubEnv('USERPROFILE', fakeHome) // Windows：os.homedir() 优先 USERPROFILE
  const cfgDir = join(fakeHome, '.pi', 'agent')
  mkdirSync(cfgDir, { recursive: true })
  rmSync(join(cfgDir, 'pi-voice.json'), { force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('config 持久化', () => {
  it('persistConfig 写入 json，重启后可读回', async () => {
    const { loadConfig, persistConfig } = await import('../config')
    persistConfig({ ttsEnabled: false, whisperToken: 's3cret-token' })
    const cfg = loadConfig({})
    expect(cfg.ttsEnabled).toBe(false)
    expect(cfg.whisperToken).toBe('s3cret-token')
  })

  it('环境变量优先，定义过的字段不落盘', async () => {
    const { loadConfig, persistConfig } = await import('../config')
    const written = persistConfig({ ttsEnabled: false }, { PI_VOICE_TTS_ENABLED: '1' })
    expect(written).not.toContain('ttsEnabled')
    const cfg = loadConfig({ PI_VOICE_TTS_ENABLED: '0' })
    expect(cfg.ttsEnabled).toBe(false)
  })

  it('合并已有字段：只更新传入的键', async () => {
    const { persistConfig } = await import('../config')
    persistConfig({ autoSend: true })
    const file = JSON.parse(readFileSync(join(fakeHome, '.pi', 'agent', 'pi-voice.json'), 'utf-8'))
    expect(file.autoSend).toBe(true)
    expect('ttsEnabled' in file).toBe(false)
  })

  it('whisperModel 默认 base，可持久化，env 优先', async () => {
    const { loadConfig, persistConfig, DEFAULTS } = await import('../config')
    expect(loadConfig({}).whisperModel).toBe('base')
    persistConfig({ whisperModel: 'small' })
    expect(loadConfig({}).whisperModel).toBe('small')
    // env 优先
    expect(loadConfig({ PI_VOICE_WHISPER_MODEL: 'tiny' }).whisperModel).toBe('tiny')
    // env 定义后不落盘
    const written = persistConfig({ whisperModel: 'medium' }, { PI_VOICE_WHISPER_MODEL: 'tiny' })
    expect(written).not.toContain('whisperModel')
    expect(loadConfig({ PI_VOICE_WHISPER_MODEL: 'tiny' }).whisperModel).toBe('tiny')
  })

  it('ttsEnabled 默认关闭（非语音状态不朗读）', async () => {
    const { loadConfig } = await import('../config')
    expect(loadConfig({}).ttsEnabled).toBe(false)
    // env 可开启
    expect(loadConfig({ PI_VOICE_TTS_ENABLED: '1' }).ttsEnabled).toBe(true)
  })

  it('whisperScript 默认指向 pi-whisper.sh，env 可覆盖', async () => {
    const { loadConfig, DEFAULTS } = await import('../config')
    expect(loadConfig({}).whisperScript).toBe(DEFAULTS.whisperScript)
    expect(loadConfig({ PI_VOICE_WHISPER_SCRIPT: '/tmp/whisper.sh' }).whisperScript).toBe('/tmp/whisper.sh')
  })

  it('sherpa 后端字段：默认值 / env 覆盖 / sherpaToken 回退 whisperToken', async () => {
    const { loadConfig, persistConfig, DEFAULTS } = await import('../config')
    const cfg = loadConfig({})
    expect(cfg.sttBackend).toBe('whisper')
    expect(cfg.sherpaEndpoint).toBe(DEFAULTS.sherpaEndpoint)
    expect(cfg.sherpaScript).toBe(DEFAULTS.sherpaScript)
    // env 覆盖
    expect(loadConfig({ PI_VOICE_STT_BACKEND: 'sherpa' }).sttBackend).toBe('sherpa')
    expect(loadConfig({ PI_VOICE_SHERPA_ENDPOINT: 'http://127.0.0.1:19999' }).sherpaEndpoint).toBe('http://127.0.0.1:19999')
    expect(loadConfig({ PI_VOICE_SHERPA_SCRIPT: '/tmp/sherpa.sh' }).sherpaScript).toBe('/tmp/sherpa.sh')
    // sherpaToken 回退 whisperToken
    persistConfig({ whisperToken: 'tok-a' }, process.env)
    expect(loadConfig({}).sherpaToken).toBe('tok-a')
    // sherpa 专属 token 优先
    persistConfig({ sherpaToken: 'tok-s' }, process.env)
    expect(loadConfig({}).sherpaToken).toBe('tok-s')
  })
})
