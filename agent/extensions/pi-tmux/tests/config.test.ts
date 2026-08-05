import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, toTmuxOpts } from '../config'

describe('pi-tmux config', () => {
  it('默认配置', () => {
    const cfg = loadConfig()
    expect(cfg.bin).toBe('tmux')
    expect(cfg.prefix).toBe('pi-')
    expect(cfg.logDir).toBe(join(homedir(), '.pi', 'logs', 'tmux'))
    expect(cfg.defaultLines).toBeGreaterThan(0)
  })

  it('环境变量覆盖', () => {
    const prev = process.env.PI_TMUX_LOG_DIR
    process.env.PI_TMUX_LOG_DIR = '~/tmp-tmux-logs'
    try {
      const cfg = loadConfig()
      expect(cfg.logDir).toBe(join(homedir(), 'tmp-tmux-logs'))
    } finally {
      if (prev === undefined) delete process.env.PI_TMUX_LOG_DIR
      else process.env.PI_TMUX_LOG_DIR = prev
    }
  })

  it('toTmuxOpts 映射', () => {
    const cfg = loadConfig()
    const opts = toTmuxOpts(cfg)
    expect(opts.bin).toBe(cfg.bin)
    expect(opts.prefix).toBe(cfg.prefix)
    expect(opts.logDir).toBe(cfg.logDir)
  })
})
