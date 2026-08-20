export type MemoryCategory = 'fact' | 'preference' | 'habit' | 'procedure' | 'reference' | 'solutions'
export type MemorySource = 'manual' | 'extract' | 'digest'
export type MemoryAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'

export interface MemoryEntry {
  id: string
  category: MemoryCategory
  title: string
  content: string
  tags: string[]
  confidence: number
  source: MemorySource
  recurrence: number
  createdAt: string
  updatedAt: string
  accessedAt: string
  /** v2: 观察到该事实的时间（自动提取时取自会话时间，可能早于 createdAt） */
  observedAt?: string
  /** v2: 被哪条记忆取代（冲突消解，软删除） */
  supersededBy?: string
  /** v2: 软删除标记 */
  deleted?: boolean
  /** v3: 适用运行环境（缺省 = all 通用）。termux/wsl2/linux/macos/windows；注入与检索按当前环境过滤 */
  environments?: string[]
  /** v4: 最近一次写入/提取该条目的会话（跨会话 round-robin 分组用） */
  lastSessionId?: string
  /** v5: 失效时间（被取代/冲突发生时点，ISO）。有值表示该条目在此刻后不再有效，供 asOf 回溯查询 */
  validUntil?: string
}

export interface SummaryEntry {
  id: string
  sessionId: string | null
  ts: string
  title: string
  decisions: string[]
  facts: string[]
  prefs: string[]
  lessons: string[]
  fullText: string
}

export interface MemoryStore {
  version: number
  entries: MemoryEntry[]
}

export interface SummaryStore {
  version: number
  summaries: SummaryEntry[]
}

export interface MemoryStats {
  totalEntries: number
  activeEntries: number
  byCategory: Record<string, number>
  totalSizeBytes: number
  oldestEntry: string | null
  newestEntry: string | null
  coldEntries: number
  summaries: number
  superseded: number
}
