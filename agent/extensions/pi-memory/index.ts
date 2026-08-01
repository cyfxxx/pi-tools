import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { loadEntries, getTotalSize } from './storage.ts'
import { registerTools } from './tools.ts'
import { registerCommands } from './commands.ts'

export default function piMemoryExtension(pi: ExtensionAPI): void {
  registerTools(pi)
  registerCommands(pi)

  pi.on('session_start', async () => {
    const entries = loadEntries()

    const totalSize = getTotalSize(entries)
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
    if (entries.length > 0) {
      console.log(`[pi-memory] loaded ${entries.length} entries (${sizeMB} MB)`)
    }
  })
}
