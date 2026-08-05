import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, isAbsolute } from 'path'
import { SESSION_PREFIX, TMUX_LOG_DIR_REL, type TmuxOpts } from './core'

/** 与 pi 一致的 agent 目录解析（getAgentDir: PI_CODING_AGENT_DIR > ~/.pi/agent） */
function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR
  const piHome = process.env.PI_HOME || join(homedir(), '.pi')
  return join(piHome, 'agent')
}

export interface TmuxConfig {
  bin: string
  prefix: string
  logDir: string
  defaultLines: number
  defaultTimeoutSec: number
}

const DEFAULTS: TmuxConfig = {
  bin: 'tmux',
  prefix: SESSION_PREFIX,
  logDir: join(homedir(), '.pi', TMUX_LOG_DIR_REL),
  defaultLines: 100,
  defaultTimeoutSec: 120,
}

const CONFIG_KEYS = ['pi-tmux', 'tmux'] as const

function readConfigFromFile(): Partial<TmuxConfig> {
  const paths = [join(agentDir(), 'settings.json'), join(process.cwd(), '.pi', 'settings.json')]
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      const sections = CONFIG_KEYS
        .map((k) => raw?.extensions?.[k] ?? raw?.[k])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      if (sections.length === 0) continue
      const merged = Object.assign({}, ...sections.reverse()) as Record<string, unknown>
      const out: Partial<TmuxConfig> = {}
      if (typeof merged.bin === 'string') out.bin = merged.bin
      if (typeof merged.prefix === 'string') out.prefix = merged.prefix
      if (typeof merged.logDir === 'string') {
        out.logDir = isAbsolute(merged.logDir) ? merged.logDir : join(homedir(), merged.logDir.replace(/^~(\/|$)/, ''))
      }
      if (typeof merged.defaultLines === 'number') out.defaultLines = merged.defaultLines
      if (typeof merged.defaultTimeoutSec === 'number') out.defaultTimeoutSec = merged.defaultTimeoutSec
      return out
    } catch {
      continue
    }
  }
  return {}
}

function readConfigFromEnv(): Partial<TmuxConfig> {
  const out: Partial<TmuxConfig> = {}
  if (process.env.PI_TMUX_BIN) out.bin = process.env.PI_TMUX_BIN
  if (process.env.PI_TMUX_PREFIX) out.prefix = process.env.PI_TMUX_PREFIX
  if (process.env.PI_TMUX_LOG_DIR) {
    out.logDir = isAbsolute(process.env.PI_TMUX_LOG_DIR)
      ? process.env.PI_TMUX_LOG_DIR
      : join(homedir(), process.env.PI_TMUX_LOG_DIR.replace(/^~(\/|$)/, ''))
  }
  if (process.env.PI_TMUX_LINES) {
    const n = parseInt(process.env.PI_TMUX_LINES, 10)
    if (!Number.isNaN(n) && n > 0) out.defaultLines = n
  }
  if (process.env.PI_TMUX_TIMEOUT_SEC) {
    const n = parseInt(process.env.PI_TMUX_TIMEOUT_SEC, 10)
    if (!Number.isNaN(n) && n > 0) out.defaultTimeoutSec = n
  }
  return out
}

export function loadConfig(): TmuxConfig {
  return { ...DEFAULTS, ...readConfigFromFile(), ...readConfigFromEnv() }
}

export function toTmuxOpts(cfg: TmuxConfig): TmuxOpts {
  return { bin: cfg.bin, prefix: cfg.prefix, logDir: cfg.logDir }
}
