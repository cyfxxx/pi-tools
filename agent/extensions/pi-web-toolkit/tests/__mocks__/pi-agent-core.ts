export interface AgentToolResult {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

export type AgentMessage = {
  role: string
  content: Array<{ type: string; text?: string }>
}
