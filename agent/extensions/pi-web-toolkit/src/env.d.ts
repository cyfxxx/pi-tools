declare module '@earendil-works/pi-coding-agent' {
  export interface ToolResult {
    content: Array<{ type: 'text'; text: string }>
    details: Record<string, unknown>
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
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        ctx: ExtensionContext,
      ) => Promise<ToolResult>
    }): void
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void
    registerCommand?(name: string, options: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void> }): void
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

  export interface ExtensionCommandContext extends ExtensionContext {
  }

  export type AgentToolUpdateCallback<T> = (data: T) => void

  export const CONFIG_DIR_NAME: string
}
