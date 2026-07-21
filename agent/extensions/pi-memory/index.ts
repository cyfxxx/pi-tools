import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { MemoryEntry, MemoryCategory } from './types.ts'
import { loadEntries, searchEntries } from './storage.ts'
import { registerTools } from './tools.ts'
import { registerCommands } from './commands.ts'

const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  preference: '偏好',
  habit: '习惯',
  fact: '事实',
  procedure: '流程',
  reference: '参考',
}

const INJECTION_ROUNDS = 2
const INJECTION_LIMIT = 5

let injectionRound = 0
let warmMemories: MemoryEntry[] = []

function formatMemories(entries: MemoryEntry[]): string {
  if (!entries.length) return ''

  const byCategory: Record<string, MemoryEntry[]> = {}
  for (const e of entries) {
    const cat = e.category
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(e)
  }

  const sections: string[] = ['## 记忆（来自 pi-memory）']

  for (const [cat, items] of Object.entries(byCategory)) {
    const label = MEMORY_CATEGORY_LABELS[cat] || cat
    const bullets = items.map(e => {
      const contentTrimmed = e.content.length > 150 ? e.content.slice(0, 150) + '...' : e.content
      return `  - ${contentTrimmed} [置信度: ${e.confidence}]`
    })
    sections.push(`\n${label}:\n${bullets.join('\n')}`)
  }

  return sections.join('\n')
}

export default function piMemoryExtension(pi: ExtensionAPI): void {
  registerTools(pi)
  registerCommands(pi)

  pi.on('session_start', async () => {
    injectionRound = 0
    const entries = loadEntries()
    warmMemories = searchEntries(entries, undefined, undefined, undefined, INJECTION_LIMIT)

    const totalSize = entries.reduce(
      (s, e) => s + Buffer.byteLength(e.title + e.content, 'utf-8'),
      0,
    )
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1)
    if (entries.length > 0) {
      console.log(`[pi-memory] loaded ${entries.length} entries (${sizeMB} MB)`)
    }
  })

  pi.on('before_agent_start', async () => {
    if (injectionRound >= INJECTION_ROUNDS || warmMemories.length === 0) return

    injectionRound++
    const content = formatMemories(warmMemories)
    if (!content) return

    return {
      message: {
        customType: 'memory-context',
        content,
        display: false,
      },
    }
  })

  pi.on('context', async (event) => {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as { customType?: string }
        if (msg.customType === 'memory-context') return false
        return true
      }),
    }
  })

  pi.on('session_shutdown', async () => {
    injectionRound = 0
    warmMemories = []
  })
}
