import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { AutopilotConfig } from './types.ts'
import { CONFIG_FILE, defaultAutopilotConfig } from './types.ts'

const AGENT_DIR = getAgentDir()

export function configPath(): string {
  return join(AGENT_DIR, CONFIG_FILE)
}

export async function readAutopilotConfig(): Promise<AutopilotConfig> {
  const def = defaultAutopilotConfig()
  try {
    const raw = await readFile(configPath(), 'utf-8')
    const data = JSON.parse(raw) as Partial<AutopilotConfig>
    return {
      ...def,
      ...data,
      fallbackModels: Array.isArray(data.fallbackModels) ? data.fallbackModels : def.fallbackModels,
      budget: { ...def.budget, ...(data.budget || {}) },
      policy: { ...def.policy, ...(data.policy || {}) },
    }
  } catch {
    return def
  }
}

export async function writeAutopilotConfig(config: AutopilotConfig): Promise<void> {
  const p = configPath()
  const tmp = p + '.tmp'
  await mkdir(dirname(p), { recursive: true })
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8')
  await rename(tmp, p)
}
