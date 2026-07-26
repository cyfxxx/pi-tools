declare module '@earendil-works/pi-coding-agent' {
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

  export interface ToolDefinition {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    parameters: ToolParameter
    prepareArguments?(args: unknown): unknown
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) => Promise<ToolResult>
  }

  export interface ExtensionContext {
    mode: 'tui' | 'rpc' | 'json' | 'print'
    hasUI: boolean
    cwd: string
    signal: AbortSignal
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
      getBranch(): Array<{ type: string; message?: { role: string; toolName?: string; details?: unknown } }>
    }
    isProjectTrusted(): boolean
    shutdown(): void
    compact(): Promise<void>
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export type AgentToolUpdateCallback<T> = (data: T) => void

  export const CONFIG_DIR_NAME: string

  export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void
    registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void> }): void
    registerFlag(name: string, options: { description: string; handler: (value: boolean) => void | Promise<void> }): void
    registerShortcut(shortcut: unknown, handler: () => void | Promise<void>): void
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void
  }

  export type Theme = Record<string, unknown>
  export type ExtensionUIContext = ExtensionContext

  export function getAgentDir(): string
  export function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string }
}

declare module '@earendil-works/pi-agent-core' {
  export interface AgentToolResult {
    content: Array<{ type: string; text: string }>
    isError?: boolean
  }

  export type AgentMessage = {
    role: string
    content: Array<{ type: string; text?: string }>
  }
}

declare module '@earendil-works/pi-ai' {
  export interface Message {
    role: string
    content: Array<{ type: string; text?: string }>
  }

  export interface AssistantMessage extends Message {}
  export interface TextContent { type: 'text'; text: string }

  export function StringEnum<T extends string>(values: T[]): { enum: T[]; type: 'string' }
}

declare module '@earendil-works/pi-tui' {
  export type TUI = Record<string, unknown>

  export const Key: {
    ctrlAlt(key: string): unknown
    enter: unknown
    escape: unknown
  }

  export class Container {
    constructor(options?: Record<string, unknown>)
    add(child: unknown): void
  }

  export class Markdown {
    constructor(text: string)
  }

  export class Spacer {
    constructor()
  }

  export class Text {
    constructor(text: string, options?: Record<string, unknown>)
  }
}

declare module 'typebox' {
  export const Type: {
    String(options?: Record<string, unknown>): { type: 'string' }
    Number(options?: Record<string, unknown>): { type: 'number' }
    Boolean(options?: Record<string, unknown>): { type: 'boolean' }
    Array(schema: unknown, options?: Record<string, unknown>): { type: 'array' }
    Object(schema: Record<string, unknown>, options?: Record<string, unknown>): { type: 'object' }
    Union(schemas: unknown[]): { anyOf: unknown[] }
    Optional(schema: unknown): unknown
    Record(key: unknown, value: unknown): { type: 'object' }
  }
}
