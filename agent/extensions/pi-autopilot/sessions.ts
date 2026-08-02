import fs from 'node:fs'
import path from 'node:path'
import { getAgentDir, parseSessionEntries } from '@earendil-works/pi-coding-agent'

const SESSIONS_BASE = path.join(getAgentDir(), 'sessions')

export interface SessionInfo {
  sessionId: string
  filePath: string
  fileName: string
  sizeBytes: number
  mtimeMs: number
  cwd: string
  firstLinePreview: string
}

function encodeCwd(cwd: string): string {
  return `--${encodeURIComponent(cwd)}--`
}

function decodeCwd(dirName: string): string {
  const inner = dirName.replace(/^--/, '').replace(/--$/, '')
  if (inner.includes('%')) {
    try {
      return decodeURIComponent(inner)
    } catch {
      return '/' + inner
    }
  }
  // Backward compatibility with the legacy `-`-separated scheme
  return '/' + inner.replace(/-/g, '/')
}

function readFirstLine(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(4096)
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0)
    fs.closeSync(fd)
    const firstLine = buffer.toString('utf-8', 0, bytesRead).split('\n')[0]
    try {
      const parsed = parseSessionEntries(firstLine)
      const session = parsed[0] as { type?: string; id?: string; timestamp?: number; header?: { type?: string; id?: string; timestamp?: number } } | undefined
      const header = session?.type === 'session' ? session : (session as { header?: { type?: string; id?: string; timestamp?: number } })?.header
      if (header?.type === 'session') {
        const id = header.id || ''
        const ts = header.timestamp ? new Date(header.timestamp).toISOString().slice(0, 19) : ''
        return `[${ts}] session ${id}`
      }
      return firstLine.slice(0, 120)
    } catch {
      return firstLine.slice(0, 120)
    }
  } catch {
    return '(无法读取)'
  }
}

export function listSessionDirs(): string[] {
  try {
    return fs.readdirSync(SESSIONS_BASE).filter(d => {
      const full = path.join(SESSIONS_BASE, d)
      return fs.statSync(full).isDirectory() && d.startsWith('--')
    })
  } catch {
    return []
  }
}

export function listSessions(cwd?: string): SessionInfo[] {
  let targetDirs: string[] = []
  if (cwd) {
    targetDirs = [encodeCwd(cwd)]
  } else {
    targetDirs = listSessionDirs()
  }

  const results: SessionInfo[] = []
  for (const dirName of targetDirs) {
    const dirPath = path.join(SESSIONS_BASE, dirName)
    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = file.includes('_') ? file.split('_').pop()?.replace('.jsonl', '') || '' : file.replace('.jsonl', '')
        results.push({
          sessionId,
          filePath,
          fileName: file,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          cwd: decodeCwd(dirName),
          firstLinePreview: readFirstLine(filePath),
        })
      }
    } catch {
      // skip inaccessible dirs
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return results
}

export function resolveSession(target: string): SessionInfo | null {
  const all = listSessions()
  const byId = all.find(s => s.sessionId.startsWith(target))
  if (byId) return byId
  const byPath = all.find(s => s.filePath === target || s.fileName === target)
  if (byPath) return byPath
  if (fs.existsSync(target) && target.endsWith('.jsonl')) {
    try {
      const stat = fs.statSync(target)
      return {
        sessionId: path.basename(target).replace('.jsonl', ''),
        filePath: target,
        fileName: path.basename(target),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        cwd: path.dirname(target),
        firstLinePreview: readFirstLine(target),
      }
    } catch {
      return null
    }
  }
  return null
}

export function getSessionsBaseDir(): string {
  return SESSIONS_BASE
}