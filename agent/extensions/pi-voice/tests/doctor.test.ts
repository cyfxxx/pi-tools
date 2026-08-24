// 审计 LOW 回归：doctor 第 2 项——linux 平台 ffmpeg 缺失时输出 info 提示
//（detectAudioLevel 的 volumedetect 依赖 ffmpeg，缺失静默降级；doctor 不应显示 ✓ 也
// 不判 ✗ 失败）。mock child_process 控制命令探测结果，stub fetch 隔离服务检查。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileMock = vi.hoisted(() => vi.fn())
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
  execFileSync: vi.fn(),
}))

import { doctor } from '../core'
import { DEFAULTS, type VoiceConfig } from '../config'

const cfg: VoiceConfig = {
  ...DEFAULTS,
  platform: 'linux',
  micBin: 'parec',
  ttsBin: 'espeak-ng',
  tmpDir: join(tmpdir(), 'pi-voice'),
}

function enoent(bin: string): Error {
  return Object.assign(new Error(`spawn ${bin} ENOENT`), {})
}

/** 按命令名分发探测结果：ffmpeg 可控，其余命令存在、nvidia-smi 缺失 */
function mockProbes(ffMissing: boolean): void {
  execFileMock.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, o?: string, s?: string) => void) => {
    if (bin === 'ffmpeg') {
      if (ffMissing) cb(enoent(bin))
      else cb(null, 'ffmpeg version 6.0', '')
      return
    }
    if (bin === 'nvidia-smi') {
      cb(enoent(bin))
      return
    }
    cb(null, 'ok', '')
  })
}

beforeEach(() => {
  execFileMock.mockReset()
  // whisper / sherpa 健康检查：网络不可达 → 各自推 ✗ 行，与本用例无关
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline (test stub)') }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('doctor linux ffmpeg 提示（审计 LOW）', () => {
  it('linux 且 ffmpeg 缺失 → info 级提示（不判 ✗ 失败）', async () => {
    mockProbes(true)
    const lines = await doctor(cfg)
    const joined = lines.join('\n')
    expect(lines.some(l => l.startsWith('ℹ') && l.includes('ffmpeg'))).toBe(true)
    expect(joined).not.toContain('✗ ffmpeg 缺失')
    expect(joined).not.toContain('✓ ffmpeg')
  })

  it('linux 且 ffmpeg 存在 → 无 ffmpeg 相关提示行', async () => {
    mockProbes(false)
    const lines = await doctor(cfg)
    expect(lines.some(l => l.includes('ffmpeg'))).toBe(false)
  })

  it('termux（needsConvert=true）行为不变：ffmpeg 缺失仍判 ✗', async () => {
    mockProbes(true)
    const termuxCfg: VoiceConfig = { ...cfg, platform: 'termux' }
    const lines = await doctor(termuxCfg)
    expect(lines).toContain('✗ ffmpeg 缺失：请 apt-get install ffmpeg')
  })
})
