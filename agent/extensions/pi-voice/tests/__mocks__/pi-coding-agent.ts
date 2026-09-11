export type ExtensionAPI = {
  registerCommand: (name: string, opts: any) => void
  registerTool: (tool: any) => void
  registerShortcut: (shortcut: any) => void
  on: (event: string, handler: any) => void
}

export type ExtensionContext = {
  hasUI: boolean
  ui: {
    notify: (message: string, type?: string) => void
    select: (title: string, options: string[]) => Promise<string | undefined>
    editor: (title: string, content: string) => Promise<string | undefined>
  }
}

export type ExtensionCommandContext = {
  args: string
  session: any
}

export default {
  ExtensionAPI: {} as ExtensionAPI,
  ExtensionContext: {} as ExtensionContext,
  ExtensionCommandContext: {} as ExtensionCommandContext,
}
