import fs from 'node:fs'
import path from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

export interface RestartLog {
  action: string
  targetSession?: string
  targetModel?: string
  targetProvider?: string
  reason?: string
  timestamp: number
}

export interface AdminState {
  action: 'none' | 'restart' | 'switch_session' | 'set_model'
  targetSession?: string
  targetModel?: string
  targetProvider?: string
  reason?: string
  timestamp: number
  restartLog: RestartLog | null
}

const STATE_FILE = path.join(getAgentDir(), '.pi-admin-state.json')

function defaultState(): AdminState {
  return { action: 'none', timestamp: 0, restartLog: null }
}

export function readState(): AdminState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    return { ...defaultState(), ...JSON.parse(raw) }
  } catch {
    return defaultState()
  }
}

export function writeState(state: Partial<AdminState>): void {
  const dir = path.dirname(STATE_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const content = JSON.stringify({ ...defaultState(), ...state }, null, 2)
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, STATE_FILE)
}

export function writeRestartRequest(
  action: 'restart' | 'switch_session' | 'set_model',
  opts: { targetSession?: string; targetModel?: string; targetProvider?: string; reason?: string } = {},
): void {
  const now = Date.now()
  const restartLog: RestartLog = {
    action,
    targetSession: opts.targetSession,
    targetModel: opts.targetModel,
    targetProvider: opts.targetProvider,
    reason: opts.reason,
    timestamp: now,
  }
  writeState({
    action,
    targetSession: opts.targetSession,
    targetModel: opts.targetModel,
    targetProvider: opts.targetProvider,
    reason: opts.reason,
    timestamp: now,
    restartLog,
  })
}

export function consumeRestartLog(): RestartLog | null {
  const state = readState()
  if (state.restartLog && state.restartLog.action !== 'none') {
    const log = state.restartLog
    writeState({ restartLog: null })
    return log
  }
  return null
}

export function getStateFilePath(): string {
  return STATE_FILE
}