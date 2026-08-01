let agentDir = '/tmp/pi-scheduler-default'

export function __setAgentDir(dir: string): void {
  agentDir = dir
}

export function getAgentDir(): string {
  return agentDir
}

export type ExtensionAPI = Record<string, unknown>
