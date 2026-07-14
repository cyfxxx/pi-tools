import { readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface LogEntry {
  name: string
  result: string
  time: string
  output: string
}

function logDir(): string {
  const home = process.env.PI_HOME || join(process.env.HOME || '/root', '.pi')
  return join(home, 'logs', 'scheduler')
}

export async function collectOfflineExecutions(): Promise<LogEntry[]> {
  const dir = logDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const unread = files
    .filter(f => f.endsWith('.log') && !f.includes('.read'))
    .sort()

  const entries: LogEntry[] = []
  for (const f of unread.slice(-20)) {
    try {
      const content = await readFile(join(dir, f), 'utf-8')
      const lines = content.split('\n')
      const header = lines[0] || ''
      const parts = header.split('|')
      entries.push({
        name: parts[0]?.trim() || f,
        result: parts[1]?.trim() || 'unknown',
        time: parts[2]?.trim() || '',
        output: lines.slice(1).join('\n').slice(0, 300),
      })
    } catch { /* skip unreadable */ }
  }

  return entries
}

export async function markRead(entry: LogEntry): Promise<void> {
  const dir = logDir()
  const files = await readdir(dir).catch(() => [] as string[])
  const target = files.find(f =>
    f.endsWith('.log') && !f.includes('.read') && f.includes(entry.name.replace(/[^a-z0-9]/gi, '_'))
  )
  if (target) {
    try {
      await rename(join(dir, target), join(dir, target + '.read'))
    } catch { /* ignore */ }
  }
}

export function formatSummary(entries: LogEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(e => {
    const icon = e.result === 'success' ? '✓' : '✗'
    return `  ${icon} ${e.name} — ${e.result}` +
      (e.output ? `\n    ${e.output.replace(/\n/g, '\n    ')}` : '')
  })
  return [
    `━━━ 离线期间定时任务执行报告 ━━━`,
    ...lines,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n')
}
