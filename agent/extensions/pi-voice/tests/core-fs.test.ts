import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupStaleAudio, deleteAudioPair } from '../core'
import type { VoiceConfig } from '../config'

function tmpCfg(): { cfg: VoiceConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-voice-core-'))
  return {
    cfg: {
      whisperEndpoint: 'http://127.0.0.1:18766',
      whisperToken: '',
      micBin: 'termux-microphone-record',
      ffmpegBin: 'ffmpeg',
      ttsBin: 'termux-tts-speak',
      tmpDir: dir,
      audioDir: dir,
      ttsEnabled: true,
      ttsMaxChars: 400,
      autoSend: false,
      maxSeconds: 120,
      language: '',
    } as VoiceConfig,
    dir,
  }
}

describe('deleteAudioPair', () => {
  it('删除 m4a 与配对的 wav', () => {
    const { cfg, dir } = tmpCfg()
    try {
      const m4a = join(dir, 'x.m4a')
      const wav = join(dir, 'x.wav')
      writeFileSync(m4a, 'a')
      writeFileSync(wav, 'b')
      deleteAudioPair(cfg, m4a)
      expect(existsSync(m4a)).toBe(false)
      expect(existsSync(wav)).toBe(false)
      // 幂等：文件不存在不报错
      deleteAudioPair(cfg, m4a)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanupStaleAudio', () => {
  it('删除过期 m4a/wav，保留新文件与非音频文件', () => {
    const { cfg, dir } = tmpCfg()
    try {
      const old1 = join(dir, 'old1.m4a')
      const old2 = join(dir, 'old2.wav')
      const fresh = join(dir, 'fresh.m4a')
      const other = join(dir, 'notes.txt')
      writeFileSync(old1, 'a')
      writeFileSync(old2, 'b')
      writeFileSync(fresh, 'c')
      writeFileSync(other, 'd')
      const now = Date.now()
      utimesSync(old1, new Date(now - 2 * 24 * 60 * 60 * 1000), new Date(now - 2 * 24 * 60 * 60 * 1000))
      utimesSync(old2, new Date(now - 2 * 24 * 60 * 60 * 1000), new Date(now - 2 * 24 * 60 * 60 * 1000))
      const removed = cleanupStaleAudio(cfg)
      expect(removed).toBe(2)
      expect(existsSync(old1)).toBe(false)
      expect(existsSync(old2)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(other)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录不存在返回 0 不报错', () => {
    const { cfg, dir } = tmpCfg()
    rmSync(dir, { recursive: true, force: true })
    expect(cleanupStaleAudio(cfg)).toBe(0)
  })
})