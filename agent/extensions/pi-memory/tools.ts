/**
 * tools.ts — 工具注册编排层
 *
 * 按功能域委托给子模块，本文件仅保留编排逻辑。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerMemoryStoreTools } from './tools/memory-store.ts'
import { registerMemorySearchTools } from './tools/memory-search.ts'
import { registerExecTool } from './tools/exec-sandbox.ts'
import { registerNotesTools } from './tools/notes-tools.ts'
import { registerCheckpointTools } from './tools/checkpoint-tools.ts'

export function registerTools(pi: ExtensionAPI): void {
  registerMemoryStoreTools(pi)
  registerMemorySearchTools(pi)
  registerExecTool(pi)
  registerNotesTools(pi)
  registerCheckpointTools(pi)
}
