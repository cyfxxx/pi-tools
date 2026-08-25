import { describe, it, expect } from 'vitest'
import { detectPlatform, resolvePlatform, platformInstallGuide, type PlatformEnv } from '../platform'
import { DEFAULTS, type VoiceConfig } from '../config'
function env(cmds: string[], platform: NodeJS.Platform = 'linux'): PlatformEnv {
  return {
    platform,
    commandExists: (name) => cmds.includes(name),
  }
}

const baseCfg: VoiceConfig = {
  ...DEFAULTS,
  platform: 'auto',
}

describe('detectPlatform', () => {
  it('存在 termux-microphone-record → termux', () => {
    expect(detectPlatform(env(['termux-microphone-record']))).toBe('termux')
  })

  it('无 termux 工具 → linux', () => {
    expect(detectPlatform(env([]))).toBe('linux')
    expect(detectPlatform(env(['parec'], 'darwin'))).toBe('linux')
  })
})

describe('resolvePlatform', () => {
  it('auto + termux 工具 → termux spec', () => {
    const spec = resolvePlatform(baseCfg, env(['termux-microphone-record']))
    expect(spec.kind).toBe('termux')
    expect(spec.recorder.ext).toBe('m4a')
    expect(spec.recorder.needsConvert).toBe(true)
  })

  it('auto + 无工具 → linux spec（wav 直出，无需转码）', () => {
    const spec = resolvePlatform(baseCfg, env([]))
    expect(spec.kind).toBe('linux')
    expect(spec.recorder.ext).toBe('wav')
    expect(spec.recorder.needsConvert).toBe(false)
  })

  it('强制 termux（即使无工具）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'termux' }, env([]))
    expect(spec.kind).toBe('termux')
  })

  it('强制 linux（即使有 termux 工具）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, env(['termux-microphone-record']))
    expect(spec.kind).toBe('linux')
  })
})

describe('termux spec 命令构造', () => {
  const spec = resolvePlatform({ ...baseCfg, platform: 'termux' }, env([]))

  it('录音参数：-e aac -f file -l 0（不限时，Node 侧计时）', () => {
    expect(spec.recorder.startArgs('/tmp/x.m4a')).toEqual(['-e', 'aac', '-f', '/tmp/x.m4a', '-l', '0'])
  })

  it('停止/查询：-q / -i；残留模式 termux-microphone-record', () => {
    expect(spec.recorder.stopArgs()).toEqual(['-q'])
    expect(spec.recorder.queryArgs()).toEqual(['-i'])
    expect(spec.recorder.residuePattern()).toBe('termux-microphone-record')
  })

  it('TTS：单参数；无独立播放', () => {
    expect(spec.tts.speakArgs('你好')).toEqual(['你好'])
    expect(spec.tts.playArgs('/tmp/x.wav')).toBeNull()
    expect(spec.tts.stageToWav).toBe(false)
  })

  it('zombiePatterns 仅含精确进程名（审计修复：含空格的 termux-api TextToSpeech 被 pkill -x 永不命中恒空转，已删）', () => {
    const pats = spec.tts.zombiePatterns()
    expect(pats).toContain('termux-tts-speak')
    expect(pats).not.toContain('termux-api TextToSpeech')
    for (const p of pats) expect(p).not.toMatch(/\s/)
  })
})

describe('linux spec 命令构造', () => {
  it('录音参数：--device + 16k 单声道 wav 直出', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, env([]))
    expect(spec.recorder.startArgs('/tmp/x.wav')).toEqual([
      '--device', 'RDPSource',
      '--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', '/tmp/x.wav',
    ])
  })

  it('设备为空 → 不带 --device（pulse 默认源）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', linuxMicDevice: '' }, env([]))
    expect(spec.recorder.startArgs('/tmp/x.wav')).toEqual([
      '--format=s16le', '--rate=16000', '--channels=1', '--file-format=wav', '/tmp/x.wav',
    ])
  })

  it('停止/查询：null（进程终止即结束，无续录判定）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, env([]))
    expect(spec.recorder.stopArgs()).toBeNull()
    expect(spec.recorder.queryArgs()).toBeNull()
    expect(spec.recorder.residuePattern()).toBeNull()
  })

  it('TTS：espeak-ng 文本文件 → wav → paplay 播放', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', ttsEngine: 'espeak-ng' }, env([]))
    const args = spec.tts.synthesizeArgs('/tmp/tts-input.txt', '/tmp/tts-stage.wav')
    expect(args[0]).toBe('-f')
    expect(args).toContain('/tmp/tts-input.txt')
    expect(args).toContain('-w')
    expect(args).toContain('/tmp/tts-stage.wav')
    expect(args).toContain('-v')
    expect(args).toContain('cmn')
    expect(args).toContain('170')
    expect(spec.tts.kind).toBe('espeak-ng')
    expect(spec.tts.stageToWav).toBe(true)
    expect(spec.tts.playArgs('/tmp/tts.wav')).toEqual(['--device', 'RDPSink', '/tmp/tts.wav'])
  })

  it('TTS：piper 模型 → wav → paplay 播放（ttsEngine=auto 且 piper 存在）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, { ...env([]), commandExists: (n) => n === 'piper' })
    expect(spec.tts.kind).toBe('piper')
    const args = spec.tts.synthesizeArgs('/tmp/tts-input.txt', '/tmp/tts-stage.wav')
    expect(args).toEqual(['-m', DEFAULTS.linuxPiperModel, '-i', '/tmp/tts-input.txt', '-f', '/tmp/tts-stage.wav'])
    expect(spec.tts.playArgs('/tmp/tts.wav')).toEqual(['--device', 'RDPSink', '/tmp/tts.wav'])
  })

  it('ttsEngine=piper 强制（即使命令不存在）', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', ttsEngine: 'piper' }, env([]))
    expect(spec.tts.kind).toBe('piper')
  })

  it('sink 为空 → paplay 不带 --device', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', linuxTtsSink: '' }, env([]))
    expect(spec.tts.playArgs('/tmp/tts.wav')).toEqual(['/tmp/tts.wav'])
  })

  it('TTS 检查命令', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', ttsEngine: 'espeak-ng' }, env([]))
    expect(spec.tts.checkArgs()).toEqual(['--version'])
  })

  it('micBin/ttsBin 为 termux 默认值时映射为 parec/espeak-ng', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, env([]))
    expect(spec.recorder.micLabel).toContain('parec')
    expect(spec.recorder.micLabel).toContain('RDPSource')
    expect(spec.tts.label).toBe('espeak-ng')
  })

  it('用户自定义 micBin/ttsBin 不被覆盖', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux', micBin: 'arecord', ttsBin: 'piper' }, env([]))
    expect(spec.recorder.micLabel).toBe('arecord (RDPSource)')
    expect(spec.tts.label).toBe('piper')
  })
})

describe('platformInstallGuide', () => {
  it('termux：ffmpeg 转码依赖', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'termux' }, env([]))
    expect(platformInstallGuide(spec)).toContain('termux-api')
    expect(platformInstallGuide(spec)).toContain('ffmpeg')
  })

  it('linux：无需 ffmpeg', () => {
    const spec = resolvePlatform({ ...baseCfg, platform: 'linux' }, env([]))
    expect(platformInstallGuide(spec)).toContain('pulseaudio-utils')
    expect(platformInstallGuide(spec)).not.toContain('apt-get install ffmpeg')
  })
})
