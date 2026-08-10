import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupStaleAudio, deleteAudioPair, waitForFileStable } from '../core'
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

describe('waitForFileStable', () => {
  it('文件出现且大小稳定 → true（模拟 MediaRecorder 延迟写入）', async () => {
    const { dir } = tmpCfg()
    const file = join(dir, 'a.m4a')
    // 模拟延迟写入：300ms 后创建，再 300ms 后增长到最终大小（moov atom 尾部写入）
    setTimeout(() => writeFileSync(file, 'x'.repeat(1000)), 100)
    setTimeout(() => writeFileSync(file, 'x'.repeat(2000)), 400)
    const ok = await waitForFileStable(file, { pollMs: 100, stableSamples: 3, maxWaitMs: 5000 })
    expect(ok).toBe(true)
  })

  it('文件一直不存在（启动即失败/单实例被占用）→ 超时 false', async () => {
    const { dir } = tmpCfg()
    const file = join(dir, 'never.m4a')
    const t0 = Date.now()
    const ok = await waitForFileStable(file, { pollMs: 50, stableSamples: 2, maxWaitMs: 300 })
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
  })

  it('恒为 0 字节（已创建但未写入）→ 超时 false', async () => {
    const { dir } = tmpCfg()
    const file = join(dir, 'empty.m4a')
    writeFileSync(file, '')
    const ok = await waitForFileStable(file, { pollMs: 50, stableSamples: 2, maxWaitMs: 300 })
    expect(ok).toBe(false)
  })

  it('持续增长的文件最终稳定 → true', async () => {
    const { dir } = tmpCfg()
    const file = join(dir, 'grow.m4a')
    let size = 100
    writeFileSync(file, 'a'.repeat(size))
    // 模拟真实 MediaRecorder：多次增长后停止（写入完成）
    const sizes = [200, 400, 700, 1100, 1100]
    for (const s of sizes) {
      await new Promise((r) => setTimeout(r, 150))
      writeFileSync(file, 'a'.repeat(s))
    }
    const ok = await waitForFileStable(file, { pollMs: 100, stableSamples: 2, maxWaitMs: 3000 })
    expect(ok).toBe(true)
  })
})