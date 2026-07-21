export type MemoryCategory = 'fact' | 'preference' | 'habit' | 'procedure' | 'reference'
export type MemorySource = 'manual' | 'extraction' | 'inference'

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
}

export interface MemoryStore {
  version: number
  entries: MemoryEntry[]
}

export interface MemoryStats {
  totalEntries: number
  byCategory: Record<string, number>
  totalSizeBytes: number
  oldestEntry: string | null
  newestEntry: string | null
  coldEntries: number
}
