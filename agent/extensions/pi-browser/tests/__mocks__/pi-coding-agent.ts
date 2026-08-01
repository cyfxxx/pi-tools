export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  details?: Record<string, unknown>
  isError?: boolean
}

export interface ToolParameter {
  type: string
  properties: Record<string, unknown>
  required?: string[]
  default?: unknown
}

export interface ExtensionAPI {
  registerTool(tool: {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    parameters: ToolParameter
    prepareArguments?(args: unknown): unknown
    execute: (...args: unknown[]) => Promise<ToolResult>
  }): void
  registerCommand(name: string, options: {
    description: string
    usage?: string
    handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>
  }): void
  registerFlag(name: string, options: {
    description: string
    type?: string
    handler: (value: boolean) => void | Promise<void>
  }): void
  registerShortcut(shortcut: unknown, handler: () => void | Promise<void>): void
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void
  sendMessage?(message: unknown): void
  appendEntry?(entry: unknown): void
  sendUserMessage?(message: string): void
  setActiveTools?(tools: string[]): void
  getFlag?(name: string): boolean | undefined
}

export interface ExtensionContext {
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  cwd: string
  signal: AbortSignal
  theme?: Record<string, unknown>
  ui: {
    notify(message: string, type?: 'info' | 'warn' | 'error' | 'success'): void
    confirm(title: string, message: string): Promise<boolean>
    select<T extends string>(title: string, options: Array<{ label: string; value: T; description?: string }>): Promise<T | null>
    input(title: string, placeholder?: string): Promise<string | null>
    setStatus(id: string, text: string): void
    setWidget(id: string, lines: string[]): void
  }
  sessionManager: {
    getSessionFile(): string | null
    getBranch(): Array<{ type: string; message?: unknown }>
    getEntries?(): unknown[]
  }
  isProjectTrusted(): boolean
  shutdown(): void
  compact(): Promise<void>
}

export interface ExtensionCommandContext extends ExtensionContext {}

export type AgentToolUpdateCallback<T> = (data: T) => void

export const CONFIG_DIR_NAME = '.pi'
export function getAgentDir(): string { return process.env.HOME + '/.pi/agent' }
export function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string; frontmatter?: Record<string, unknown>; body?: string } {
  return { data: {}, content, frontmatter: {}, body: content }
}
export function getMarkdownTheme(): Record<string, unknown> { return {} }
export function withFileMutationQueue<T>(fn: () => T): T { return fn() }

export type Theme = Record<string, unknown>
export type Message = { role: string; content: Array<{ type: string; text?: string }> }
