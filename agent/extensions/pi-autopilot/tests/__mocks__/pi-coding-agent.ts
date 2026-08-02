let agentDir = '/tmp/pi-autopilot-default'

export function __setAgentDir(dir: string): void {
  agentDir = dir
}

export function getAgentDir(): string {
  return agentDir
}

export function parseSessionEntries(): unknown[] {
  return []
}

export type ExtensionAPI = Record<string, unknown>
