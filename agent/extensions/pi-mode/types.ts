export interface ModeConfig {
  description: string
  extensions: string[]
  skills: string[]
  systemPrompt: string | null
  appendSystemPrompt: string | null
  thinking: string | null
}

export interface ModesFile {
  default: string
  current: string
  modes: Record<string, ModeConfig>
}
