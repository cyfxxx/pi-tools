import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'pi-voice-home-'))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('HOME', fakeHome)
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
})