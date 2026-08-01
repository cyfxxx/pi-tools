export interface Message {
  role: string
  content: Array<{ type: string; text?: string }>
  usage?: { promptTokens?: number; completionTokens?: number }
  model?: string
  stopReason?: string
  errorMessage?: string
}

export interface AssistantMessage extends Message {}
export interface TextContent { type: 'text'; text: string }

export function StringEnum<T extends string>(values: T[]): { enum: T[]; type: 'string' } {
  return { enum: values, type: 'string' }
}
