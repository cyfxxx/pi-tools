import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, toTmuxOpts } from '../config'

describe('pi-tmux config', () => {
  it('默认配置（无 PI_HOME 时回退 ~/.pi/logs/tmux）', () => {
    const prevHome = process.env.PI_HOME
    delete process.env.PI_HOME
    try {
      const cfg = loadConfig()
      expect(cfg.bin).toBe('tmux')
      expect(cfg.prefix).toBe('pi-')
      // 回归：默认 logDir 与 core.ts registryPath/defaultOpts 同口径（PI_HOME || ~/.pi）
      expect(cfg.logDir).toBe(join(homedir(), '.pi', 'logs', 'tmux'))
      expect(cfg.defaultLines).toBeGreaterThan(0)
    } finally {
      if (prevHome !== undefined) process.env.PI_HOME = prevHome
    }
  })

  it('PI_HOME 生效：logDir 改为 $PI_HOME/logs/tmux（与 core defaultOpts/registryPath 同口径）', () => {
    const prevHome = process.env.PI_HOME
    process.env.PI_HOME = '/data/pi-home-x'
    try {
      const cfg = loadConfig()
      expect(cfg.logDir).toBe(join('/data/pi-home-x', 'logs', 'tmux'))
      expect(cfg.bin).toBe('tmux')
      expect(cfg.prefix).toBe('pi-')
    } finally {
      if (prevHome === undefined) delete process.env.PI_HOME
      else process.env.PI_HOME = prevHome
    }
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
