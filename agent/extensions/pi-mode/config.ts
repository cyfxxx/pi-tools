import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ModesFile, ModeConfig } from './types.ts'

const MODES_FILE = join(process.env.HOME || '~', '.pi', 'agent', 'modes.json')

const DEFAULT_MODES: ModesFile = {
  default: 'full',
  current: 'full',
  modes: {
    full: {
      description: '完整模式 - 所有扩展和技能可用',
      extensions: [],
      skills: [],
      systemPrompt: null,
      appendSystemPrompt: null,
      thinking: null,
    },
  },
}

export function loadModes(): ModesFile {
  if (!existsSync(MODES_FILE)) {
    saveModes(DEFAULT_MODES)
    return DEFAULT_MODES
  }
  try {
    return JSON.parse(readFileSync(MODES_FILE, 'utf-8'))
  } catch {
    return DEFAULT_MODES
  }
}

export function saveModes(modes: ModesFile): void {
  mkdirSync(dirname(MODES_FILE), { recursive: true })
  writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2), 'utf-8')
}

export function getCurrentMode(): string {
  const modes = loadModes()
  return modes.current || modes.default || 'full'
}

export function getModeConfig(modeName: string): ModeConfig | null {
  const modes = loadModes()
  return modes.modes[modeName] || null
}

export function setCurrentMode(modeName: string): void {
  const modes = loadModes()
  modes.current = modeName
  saveModes(modes)
}

export function listModeNames(): string[] {
  const modes = loadModes()
  return Object.keys(modes.modes)
}

export function getDefaultMode(): string {
  const modes = loadModes()
  return modes.default || 'full'
}
