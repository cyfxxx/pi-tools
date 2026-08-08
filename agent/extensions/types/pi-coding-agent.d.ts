declare module '@earendil-works/pi-coding-agent' {
  export interface ToolResult {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    details?: unknown
    isError?: boolean
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number; contextTokens?: number }
    terminate?: boolean
  }

  export type ToolExecutionMode = 'sequential' | 'parallel'

  export interface ToolParameter {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    enum?: unknown[]
    [k: string]: unknown
  }

  export interface ToolDefinition {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    parameters: ToolParameter
    prepareArguments?(args: unknown): unknown
    executionMode?: ToolExecutionMode
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) => Promise<ToolResult>
    renderCall?: (args: Record<string, unknown>, theme: Theme, context: unknown) => unknown
    renderResult?: (result: ToolResult, options: { expanded?: boolean }, theme: Theme, context: unknown) => unknown
  }

  export type ExtensionMode = 'tui' | 'rpc' | 'json' | 'print'

  export interface ContextUsage {
    tokens: number | null
    contextWindow: number
    percent: number
  }

  export interface CompactOptions {
    cancel?: boolean
    customInstructions?: string
    onComplete?: (result: unknown) => void
    onError?: (error: Error) => void
  }

  export interface ExtensionUIContext {
    select(title: string, options: string[], opts?: Record<string, unknown>): Promise<string | undefined>
    confirm(title: string, message: string, opts?: Record<string, unknown>): Promise<boolean>
    input(title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<string | undefined>
    notify(message: string, type?: 'info' | 'warning' | 'error' | 'success'): void
    onTerminalInput(handler: (data: string) => void): () => void
    setStatus(key: string, text: string | undefined): void
    setWorkingMessage(message?: string): void
    setWorkingVisible(visible: boolean): void
    setHiddenThinkingLabel(label?: string): void
    setWidget(key: string, content: string[] | ((tui: TUI, theme: Theme) => { dispose?(): void; render?(width: number): string[]; invalidate?(): void; [k: string]: unknown }) | undefined, options?: Record<string, unknown>): void
    setFooter(factory: unknown): void
    setHeader(factory: unknown): void
    setTitle(title: string): void
    custom<T>(factory: unknown, options?: Record<string, unknown>): Promise<T>
    pasteToEditor(text: string): void
    setEditorText(text: string): void
    getEditorText(): string
    editor(title: string, prefill?: string): Promise<string | undefined>
    addAutocompleteProvider(factory: unknown): void
    setEditorComponent(factory: unknown): void
    getEditorComponent(): unknown
    readonly theme: { fg(color: string, text: string): string } & Record<string, unknown>
    getAllThemes(): Array<{ name: string; path: string | undefined }>
    getTheme(name: string): unknown
    setTheme(theme: string | Record<string, unknown>): { success: boolean; error?: string }
    getToolsExpanded(): boolean
    setToolsExpanded(expanded: boolean): void
  }

  export interface ExtensionContext {
    mode: ExtensionMode
    hasUI: boolean
    cwd: string
    signal?: AbortSignal
    model?: unknown
    thinkingLevel?: string
    ui: ExtensionUIContext
    sessionManager: {
      getSessionFile(): string | null
      getSessionId(): string | null
      getCwd(): string | null
      getBranch(): Array<{ type: string; message?: { role: string; toolName?: string; details?: unknown } }>
      getEntries(): Array<{ type: string; role?: string; customType?: string; content?: unknown; message?: { role?: string } }>
      getSessionName(): string | null
      getTree(): unknown
      setSessionName(name: string): void
      setLabel(entryId: string, label: string): void
      addEntry(entry: unknown): string
      addEntries(entries: unknown[]): void
      removeEntry(entryId: string): void
      updateEntry(entryId: string, entry: unknown): void
      save(): Promise<void>
    }
    isIdle(): boolean
    isProjectTrusted(): boolean
    hasPendingMessages(): boolean
    shutdown(): void
    abort(): void
    compact(options?: CompactOptions): void
    getContextUsage(): ContextUsage | undefined
    getSystemPrompt(): string
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    getSystemPromptOptions(): unknown
    waitForIdle(): Promise<void>
    newSession(options?: { parentSession?: string; setup?: (sessionManager: unknown) => Promise<void>; withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }>
    fork(entryId: string, options?: { position?: 'before' | 'at'; withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }>
    navigateTree(targetId: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>
    switchSession(sessionPath: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>
    reload(): Promise<void>
  }

  export interface ReplacedSessionContext extends ExtensionCommandContext {
    sendMessage(message: { customType: string; content?: unknown; display?: unknown; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): Promise<void>
    sendUserMessage(content: string | Array<{ type: string; text?: string }>, options?: { deliverAs?: 'steer' | 'followUp' }): Promise<void>
  }

  export type AgentToolUpdateCallback<T> = (data: T) => void

  export const CONFIG_DIR_NAME: string

  export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void
    registerCommand(name: string, options: { description?: string; usage?: string; getArgumentCompletions?: (argumentPrefix: string) => unknown | null | Promise<unknown | null>; handler: (args: string, ctx: ExtensionCommandContext) => any }): void
    registerFlag(name: string, options: { description?: string; type: 'boolean' | 'string'; default?: boolean | string }): void
    registerShortcut(shortcut: unknown, options: { description?: string; handler: (ctx: ExtensionContext) => void | Promise<void> }): void
    registerProvider(name: string, config: Record<string, unknown>): void
    getFlag(name: string): boolean | string | undefined
    sendMessage(message: { customType: string; content?: unknown; display?: unknown; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void
    sendUserMessage(content: string | Array<{ type: string; text?: string }>, options?: { deliverAs?: 'steer' | 'followUp' | 'nextTurn' }): void
    appendEntry(customType: string | { role?: string; content?: unknown; customType?: string; display?: unknown; details?: unknown }, data?: unknown): void
    setActiveTools(toolNames: string[]): void
    exec(command: string, args: string[], options?: Record<string, unknown>): Promise<unknown>
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void
    events: {
      emit(channel: string, data: unknown): void
      on(channel: string, handler: (data: unknown) => void): () => void
    }
  }

  export interface SessionManager {
    getSessionFile(): string | null
    getSessionId(): string | null
    getCwd(): string | null
    getBranch(): Array<{ type: string; message?: { role: string; toolName?: string; details?: unknown } }>
    getEntries(): Array<{ type: string; role?: string; customType?: string; content?: unknown; message?: { role?: string } }>
    getSessionName(): string | null
    getTree(): unknown
    setSessionName(name: string): void
    setLabel(entryId: string, label: string): void
    addEntry(entry: unknown): string
    addEntries(entries: unknown[]): void
    removeEntry(entryId: string): void
    updateEntry(entryId: string, entry: unknown): void
    save(): Promise<void>
  }

  export type Theme = Record<string, unknown> & {
    fg(color: string, text: string): string
    bg(color: string, text: string): string
    bold(text: string): string
    italic(text: string): string
    underline(text: string): string
    inverse(text: string): string
    strikethrough(text: string): string
    getFgAnsi(color: string): string
    [k: string]: unknown
  }
  export type TUI = Record<string, unknown> & {
    requestRender(): void
    [k: string]: unknown
  }
  export type MessageRenderer = unknown
  export type EntryRenderer = unknown
  export type ExtensionHandler = unknown

  export interface AgentToolResult<T = unknown> {
    content: Array<{ type: string; text?: string; image?: string; mimeType?: string }>
    details: T
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number; contextTokens?: number }
    isError?: boolean
    terminate?: boolean
  }

  export interface Usage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning?: number
    totalTokens: number
    cost?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      total: number
    }
    contextTokens?: number
  }

  export interface TruncationResult {
    content: string
    truncated: boolean
    truncatedBy: 'lines' | 'bytes' | null
    totalLines: number
    totalBytes: number
    outputLines: number
    outputBytes: number
    lastLinePartial: boolean
    firstLineExceedsLimit: boolean
    maxLines: number
    maxBytes: number
  }

  export interface TruncationOptions {
    maxLines?: number
    maxBytes?: number
  }

  export function getAgentDir(): string
  export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string }
  export function getMarkdownTheme(): import('@earendil-works/pi-tui').MarkdownTheme
  export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>
  export function calculateContextTokens(usage: Partial<Usage>): number
  export function estimateTokens(message: unknown): number
  export function estimateContextTokens(messages: unknown[]): { tokens: number; usageMessages: number }
  export function serializeConversation(messages: unknown[]): string
  export function convertToLlm(messages: unknown[]): unknown[]
  export function findCutPoint(messages: unknown[], maxTokens: number): number
  export function findTurnStartIndex(messages: unknown[]): number
  export function parseSessionEntries(content: string): unknown[]
  export function getLatestCompactionEntry(entries: unknown[]): unknown | null
  export function shouldCompact(context: unknown, settings: Record<string, unknown>): boolean
  export const DEFAULT_MAX_BYTES: number
  export const DEFAULT_MAX_LINES: number
  export function formatSize(bytes: number): string
  export function truncateHead(content: string, options?: TruncationOptions): TruncationResult
  export function truncateTail(content: string, options?: TruncationOptions): TruncationResult
  export function truncateLine(line: string, maxChars?: number): { text: string; wasTruncated: boolean }
}

declare module '@earendil-works/pi-agent-core' {
  import { type Usage } from '@earendil-works/pi-coding-agent'

  export interface AgentToolResult<T = unknown> {
    content: Array<{ type: string; text?: string; image?: string; mimeType?: string }>
    details: T
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number; contextTokens?: number }
    isError?: boolean
    terminate?: boolean
  }

  export interface AgentToolUpdateCallback<T> {
    (data: T): void
  }

  export type ToolExecutionMode = 'sequential' | 'parallel'

  export interface AgentMessage {
    role: string
    content: Array<{ type: string; text?: string; [k: string]: unknown }> | string
    [k: string]: unknown
  }

  export interface AgentContext {
    systemPrompt: string
    messages: AgentMessage[]
    tools?: unknown[]
  }

  export interface AgentToolResultDetails {}
}

declare module '@earendil-works/pi-ai' {
  export interface Message {
    role: string
    content: Array<{ type: string; text?: string; [k: string]: unknown }>
    timestamp?: number
    model?: string
    stopReason?: string
    errorMessage?: string
    usage?: Partial<Usage>
    [k: string]: unknown
  }

  export interface AssistantMessage extends Message {
    [k: string]: unknown
  }
  export interface UserMessage extends Message {
    [k: string]: unknown
  }
  export interface TextContent { type: 'text'; text: string; [k: string]: unknown }
  export interface ImageContent { type: 'image'; data: string; mimeType: string; [k: string]: unknown }
  export interface ToolCall { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  export interface ThinkingContent { type: 'thinking'; thinking: string; signature?: string }

  export function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): { enum: T[number][]; type: 'string' }
}

declare module '@earendil-works/pi-tui' {
  export interface Component {
    render(width: number): string[]
    handleInput?(data: string): void
    wantsKeyRelease?: boolean
    invalidate(): void
  }

  export class Container implements Component {
    children: Component[]
    constructor(options?: Record<string, unknown>)
    addChild(component: Component): void
    removeChild(component: Component): void
    clear(): void
    invalidate(): void
    render(width: number): string[]
  }

  export class Box extends Container {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string)
    addChild(component: Component): void
    setBgFn(bgFn?: (text: string) => string): void
  }

  export interface DefaultTextStyle {
    color?: (text: string) => string
    bgColor?: (text: string) => string
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    underline?: boolean
  }

  export interface MarkdownTheme {
    heading: (text: string) => string
    link: (text: string) => string
    linkUrl: (text: string) => string
    code: (text: string) => string
    codeBlock: (text: string) => string
    codeBlockBorder: (text: string) => string
    quote: (text: string) => string
    quoteBorder: (text: string) => string
    hr: (text: string) => string
    listBullet: (text: string) => string
    bold: (text: string) => string
    italic: (text: string) => string
    strikethrough: (text: string) => string
    underline: (text: string) => string
    highlightCode?: (code: string, lang?: string) => string[]
    codeBlockIndent?: string
  }

  export class Markdown implements Component {
    constructor(text: string, paddingX?: number, paddingY?: number, theme?: MarkdownTheme, defaultTextStyle?: DefaultTextStyle, options?: Record<string, unknown>)
    setText(text: string): void
    invalidate(): void
    render(width: number): string[]
  }

  export class Spacer implements Component {
    constructor(lines?: number)
    setLines(lines: number): void
    invalidate(): void
    render(_width: number): string[]
  }

  export class Text implements Component {
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string)
    setText(text: string): void
    setCustomBgFn(customBgFn?: (text: string) => string): void
    invalidate(): void
    render(width: number): string[]
  }

  export type TUI = Record<string, unknown> & {
    requestRender(): void
    [k: string]: unknown
  }

  export const Key: {
    escape: 'escape'
    esc: 'esc'
    enter: 'enter'
    return: 'return'
    tab: 'tab'
    space: 'space'
    backspace: 'backspace'
    delete: 'delete'
    insert: 'insert'
    home: 'home'
    end: 'end'
    pageUp: 'pageUp'
    pageDown: 'pageDown'
    up: 'up'
    down: 'down'
    left: 'left'
    right: 'right'
    f1: 'f1'
    f2: 'f2'
    f3: 'f3'
    f4: 'f4'
    f5: 'f5'
    f6: 'f6'
    f7: 'f7'
    f8: 'f8'
    f9: 'f9'
    f10: 'f10'
    f11: 'f11'
    f12: 'f12'
    ctrl(key: string): string
    shift(key: string): string
    alt(key: string): string
    super(key: string): string
    ctrlShift(key: string): string
    shiftCtrl(key: string): string
    ctrlAlt(key: string): string
    altCtrl(key: string): string
    shiftAlt(key: string): string
    altShift(key: string): string
    ctrlSuper(key: string): string
    superCtrl(key: string): string
    shiftSuper(key: string): string
    superShift(key: string): string
    altSuper(key: string): string
    superAlt(key: string): string
    ctrlShiftAlt(key: string): string
    ctrlShiftSuper(key: string): string
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
    StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): { enum: T[number][]; type: 'string' }
  }
}
