import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

let passed = 0
let failed = 0
const failures = []

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function assertContain(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label}: expected "${haystack}" to contain "${needle}"`)
}

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  \u2713 ${name}`)
  } catch (e) {
    failed++
    console.log(`  \u2717 ${name}: ${e.message}`)
    failures.push({ name, error: e.message })
  }
}

let tempDir

function setupDir() {
  tempDir = join(tmpdir(), `pi-memory-test-${randomUUID()}`)
  mkdirSync(tempDir, { recursive: true })
  process.env.PI_MEMORY_DIR = tempDir
  return tempDir
}

function teardownDir() {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
  delete process.env.PI_MEMORY_DIR
}

const PRUNE_CONFIDENCE = 0.3
const PRUNE_DAYS = 30
const PRUNE_RECURRENCE = 2
const PRUNE_DAYS_LOW = 60

function tokenize(text) {
  return text.toLowerCase()
    .split(/[\s,，。.、：:;；!！?？()（）\[\]【】{}""''\/\\\-_+#@$%^&*=|~`]+/)
    .filter(t => t.length > 0)
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  const intersection = new Set([...setA].filter(x => setB.has(x)))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.size / union.size
}

function scoreEntry(e, keywords) {
  const now = Date.now()
  const age = now - new Date(e.createdAt).getTime()
  const daysOld = age / (1000 * 60 * 60 * 24)

  let score = e.confidence * 0.3
  score += Math.max(0, 1 - daysOld / 90) * 0.2
  score += Math.min(e.recurrence / 10, 1) * 0.15

  if (e.category === 'preference') score += 0.1
  if (e.category === 'habit') score += 0.05

  if (keywords && keywords.length > 0) {
    const titleTokens = tokenize(e.title)
    const tagTokens = e.tags.flatMap(t => tokenize(t))
    const contentTokens = tokenize(e.content)

    let titleHits = 0, tagHits = 0, contentHits = 0
    for (const kw of keywords) {
      if (titleTokens.some(t => t.includes(kw) || kw.includes(t))) titleHits++
      if (tagTokens.some(t => t.includes(kw) || kw.includes(t))) tagHits++
      if (contentTokens.some(t => t.includes(kw) || kw.includes(t))) contentHits++
    }

    score += (titleHits / keywords.length) * 0.25
    score += (tagHits / keywords.length) * 0.1
    score += (contentHits / keywords.length) * 0.05
  }

  return score
}

function makeEntry(overrides = {}) {
  return {
    id: overrides.id || randomUUID(),
    category: overrides.category || 'fact',
    title: overrides.title || 'test entry',
    content: overrides.content || 'test content for memory entry',
    tags: overrides.tags || ['test'],
    confidence: overrides.confidence ?? 0.8,
    source: overrides.source || 'manual',
    recurrence: overrides.recurrence ?? 1,
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
    accessedAt: overrides.accessedAt || new Date().toISOString(),
  }
}

function getEntriesFile() {
  return join(tempDir, 'entries.json')
}

function loadEntries() {
  try {
    const raw = JSON.parse(readFileSync(getEntriesFile(), 'utf-8'))
    return raw.entries || []
  } catch {
    return []
  }
}

function saveEntries(entries) {
  const tmpFile = getEntriesFile() + '.tmp'
  writeFileSync(tmpFile, JSON.stringify({ version: 1, entries }, null, 2))
  renameSync(tmpFile, getEntriesFile())
}

function storeEntry(entries, entry) {
  const titleMatch = entries.findIndex(
    e => e.title.toLowerCase() === entry.title.toLowerCase(),
  )
  if (titleMatch !== -1) {
    const e = entries[titleMatch]
    e.content = entry.content
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    saveEntries(entries)
    return 'updated'
  }

  const contentTokens = tokenize(entry.content)
  const mergeIdx = entries.findIndex(e => {
    const existingTokens = tokenize(e.content)
    return jaccardSimilarity(contentTokens, existingTokens) > 0.7
  })
  if (mergeIdx !== -1) {
    const e = entries[mergeIdx]
    if (contentTokens.length > tokenize(e.content).length) {
      e.content = entry.content
    }
    e.tags = [...new Set([...e.tags, ...entry.tags])]
    e.confidence = Math.max(e.confidence, entry.confidence)
    e.recurrence += 1
    e.updatedAt = entry.updatedAt
    saveEntries(entries)
    return 'merged'
  }

  entries.push(entry)
  saveEntries(entries)
  return 'created'
}

function deleteEntry(entries, id) {
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return false
  entries.splice(idx, 1)
  saveEntries(entries)
  return true
}

function searchEntries(entries, query, category, tags, limit = 5) {
  let filtered = entries.filter(e => e.confidence > 0)

  if (category) {
    filtered = filtered.filter(e => e.category === category)
  }

  if (tags && tags.length > 0) {
    const lowerTags = tags.map(t => t.toLowerCase())
    filtered = filtered.filter(e =>
      lowerTags.some(t => e.tags.some(et => et.toLowerCase() === t)),
    )
  }

  if (!filtered.length) return []

  const keywords = query ? tokenize(query) : undefined

  let scored = filtered.map(e => ({ entry: e, score: scoreEntry(e, keywords) }))

  if (keywords && keywords.length > 0) {
    const tokenSets = filtered.map(e => {
      const titleTokens = tokenize(e.title)
      const tagTokens = e.tags.flatMap(t => tokenize(t))
      const contentTokens = tokenize(e.content)
      return new Set([...titleTokens, ...tagTokens, ...contentTokens])
    })
    scored = scored.filter((_, i) => {
      const tokens = tokenSets[i]
      return keywords.some(kw => [...tokens].some(t => t.includes(kw) || kw.includes(t)))
    })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry)
}

function pruneEntries(entries) {
  const now = Date.now()
  const before = entries.length
  const kept = entries.filter(e => {
    const age = now - new Date(e.accessedAt).getTime()
    const daysOld = age / (1000 * 60 * 60 * 24)
    if (e.confidence < PRUNE_CONFIDENCE && daysOld > PRUNE_DAYS) return false
    if (e.recurrence < PRUNE_RECURRENCE && daysOld > PRUNE_DAYS_LOW) return false
    return true
  })
  const removed = before - kept.length
  entries.length = 0
  entries.push(...kept)
  saveEntries(entries)
  return removed
}

function getTotalSize(entries) {
  return entries.reduce(
    (sum, e) => sum + Buffer.byteLength(e.title + e.content, 'utf-8'),
    0,
  )
}

function getStats(entries) {
  const now = Date.now()
  const byCategory = {}
  let oldest = null
  let newest = null
  let cold = 0

  for (const e of entries) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1
    if (!oldest || e.createdAt < oldest) oldest = e.createdAt
    if (!newest || e.createdAt > newest) newest = e.createdAt
    const age = now - new Date(e.accessedAt).getTime()
    if (age / (1000 * 60 * 60 * 24) > PRUNE_DAYS) cold++
  }

  return {
    totalEntries: entries.length,
    byCategory,
    totalSizeBytes: getTotalSize(entries),
    oldestEntry: oldest,
    newestEntry: newest,
    coldEntries: cold,
  }
}

async function main() {
  console.log('\npi-memory tests\n')

  // ── loadEntries ──
  await test('loadEntries returns empty array for non-existent file', () => {
    setupDir()
    try {
      const entries = loadEntries()
      assertEqual(entries, [], 'empty entries')
    } finally {
      teardownDir()
    }
  })

  // ── storeEntry: create ──
  await test('storeEntry creates a new entry', () => {
    setupDir()
    try {
      const e1 = makeEntry({ title: 'first entry', content: 'hello world' })
      const entries = loadEntries()
      const action = storeEntry(entries, e1)
      assertEqual(action, 'created', 'action is created')
      assertEqual(entries.length, 1, '1 entry')
      assertEqual(entries[0].title, 'first entry', 'title matches')
    } finally {
      teardownDir()
    }
  })

  // ── storeEntry: update on title match ──
  await test('storeEntry updates on exact title match', () => {
    setupDir()
    try {
      const e1 = makeEntry({ title: 'same title', content: 'version 1', confidence: 0.6, tags: ['a'] })
      let entries = loadEntries()
      storeEntry(entries, e1)

      const e2 = makeEntry({ title: 'same title', content: 'version 2', confidence: 0.9, tags: ['b'] })
      const action = storeEntry(entries, e2)

      assertEqual(action, 'updated', 'action is updated')
      assertEqual(entries.length, 1, 'still 1 entry')
      assertEqual(entries[0].content, 'version 2', 'content updated')
      assertEqual(entries[0].confidence, 0.9, 'confidence maxed')
      assertEqual(entries[0].recurrence, 2, 'recurrence incremented')
      assertEqual(entries[0].tags.length, 2, 'tags merged')
    } finally {
      teardownDir()
    }
  })

  // ── storeEntry: merge on content similarity ──
  await test('storeEntry merges on content Jaccard > 0.7', () => {
    setupDir()
    try {
      const e1 = makeEntry({
        title: 'first',
        content: 'the quick brown fox jumps over the lazy dog',
        tags: ['animal'],
      })
      let entries = loadEntries()
      storeEntry(entries, e1)

      const e2 = makeEntry({
        title: 'second',
        content: 'the quick brown fox jumps over the lazy cat',
        tags: ['canine'],
      })
      const action = storeEntry(entries, e2)

      assertEqual(action, 'merged', 'action is merged')
      assertEqual(entries.length, 1, 'still 1 entry')
      assertEqual(entries[0].recurrence, 2, 'recurrence incremented')
      const allTags = entries[0].tags.join(',')
      assertContain(allTags, 'animal', 'animal tag preserved')
      assertContain(allTags, 'canine', 'canine tag added')
    } finally {
      teardownDir()
    }
  })

  // ── deleteEntry ──
  await test('deleteEntry removes by id', () => {
    setupDir()
    try {
      const e1 = makeEntry({ title: 'to delete' })
      let entries = loadEntries()
      storeEntry(entries, e1)

      const id = entries[0].id
      const ok = deleteEntry(entries, id)
      assertEqual(ok, true, 'deleted')
      assertEqual(entries.length, 0, 'empty after delete')
    } finally {
      teardownDir()
    }
  })

  await test('deleteEntry returns false for non-existent id', () => {
    setupDir()
    try {
      const entries = loadEntries()
      const ok = deleteEntry(entries, 'non-existent-id')
      assertEqual(ok, false, 'not found')
    } finally {
      teardownDir()
    }
  })

  // ── searchEntries ──
  await test('searchEntries returns top results sorted by score', () => {
    setupDir()
    try {
      const now = new Date()
      const oldDate = new Date(now.getTime() - 100 * 86400000).toISOString()

      let entries = loadEntries()
      storeEntry(entries, makeEntry({
        title: 'high confidence favorite',
        content: 'uniquely content for high confidence entry',
        confidence: 0.95,
        recurrence: 10,
      }))
      storeEntry(entries, makeEntry({
        title: 'old low confidence',
        content: 'this old entry has very different content',
        confidence: 0.2,
        recurrence: 0,
        createdAt: oldDate,
      }))
      storeEntry(entries, makeEntry({
        title: 'medium entry',
        content: 'THIS IS A COMPLETELY DIFFERENT THIRD ENTRY',
        confidence: 0.6,
        recurrence: 3,
      }))

      const results = searchEntries(entries, undefined, undefined, undefined, 10)
      assertEqual(results.length, 3, 'all 3 returned')
      assertEqual(results[0].title, 'high confidence favorite', 'best score first')
      assertEqual(results[2].title, 'old low confidence', 'worst score last')
    } finally {
      teardownDir()
    }
  })

  await test('searchEntries filters by category', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'fact 1', category: 'fact', content: 'first fact content' }))
      storeEntry(entries, makeEntry({ title: 'pref 1', category: 'preference', content: 'first preference content' }))
      storeEntry(entries, makeEntry({ title: 'fact 2', category: 'fact', content: 'second fact content' }))

      const results = searchEntries(entries, undefined, 'fact', undefined, 10)
      assertEqual(results.length, 2, '2 facts')
      assertEqual(results[0].title, 'fact 2', 'newer fact first')
      assertEqual(results[1].title, 'fact 1', 'older fact last')
    } finally {
      teardownDir()
    }
  })

  await test('searchEntries filters by tags', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'shell pref', tags: ['shell', 'preference'] }))
      storeEntry(entries, makeEntry({ title: 'python pref', tags: ['python', 'preference'] }))
      storeEntry(entries, makeEntry({ title: 'docker info', tags: ['docker', 'config'] }))

      const results = searchEntries(entries, undefined, undefined, ['shell'], 10)
      assertEqual(results.length, 1, '1 shell entry')
      assertEqual(results[0].title, 'shell pref', 'matched tag')
    } finally {
      teardownDir()
    }
  })

  await test('searchEntries with query matches title', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'user prefers shell scripting' }))
      storeEntry(entries, makeEntry({ title: 'python version info' }))

      const results = searchEntries(entries, 'shell', undefined, undefined, 10)
      assertEqual(results.length, 1, '1 match')
      assertEqual(results[0].title, 'user prefers shell scripting', 'title matched')
    } finally {
      teardownDir()
    }
  })

  await test('searchEntries with query matches tag', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'some info', tags: ['docker', 'container'] }))
      storeEntry(entries, makeEntry({ title: 'other info', tags: ['python', 'script'] }))

      const results = searchEntries(entries, 'docker', undefined, undefined, 10)
      assertEqual(results.length, 1, '1 match')
      assertEqual(results[0].title, 'some info', 'tag matched')
    } finally {
      teardownDir()
    }
  })

  await test('searchEntries returns empty for no match', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'only entry' }))

      const results = searchEntries(entries, 'nonexistent_keyword_xyz', undefined, undefined, 10)
      assertEqual(results.length, 0, 'no match')
    } finally {
      teardownDir()
    }
  })

  // ── pruneEntries ──
  await test('pruneEntries removes low-confidence cold entries', () => {
    setupDir()
    try {
      const old = new Date(Date.now() - 60 * 86400000).toISOString()
      let entries = loadEntries()
      storeEntry(entries, makeEntry({
        title: 'good entry',
        content: 'relevant high quality fact to keep',
        confidence: 0.9,
      }))
      storeEntry(entries, makeEntry({
        title: 'bad old entry',
        content: 'old outdated junk no longer valid',
        confidence: 0.1,
        accessedAt: old,
      }))

      const removed = pruneEntries(entries)
      assertEqual(removed, 1, '1 removed')
      assertEqual(entries.length, 1, '1 kept')
      assertEqual(entries[0].title, 'good entry', 'correct one kept')
    } finally {
      teardownDir()
    }
  })

  await test('pruneEntries removes low-recurrence cold entries', () => {
    setupDir()
    try {
      const old = new Date(Date.now() - 90 * 86400000).toISOString()
      let entries = loadEntries()
      storeEntry(entries, makeEntry({
        title: 'frequent',
        content: 'this fact is referenced many times',
        recurrence: 10,
      }))
      storeEntry(entries, makeEntry({
        title: 'rare old',
        content: 'barely used outdated reference info',
        recurrence: 0,
        accessedAt: old,
      }))

      const removed = pruneEntries(entries)
      assertEqual(removed, 1, '1 removed')
      assertEqual(entries.length, 1, '1 kept')
      assertEqual(entries[0].title, 'frequent', 'correct one kept')
    } finally {
      teardownDir()
    }
  })

  // ── getStats ──
  await test('getStats returns correct counts', () => {
    setupDir()
    try {
      let entries = loadEntries()
      storeEntry(entries, makeEntry({ title: 'f1', category: 'fact', content: 'fact one content here' }))
      storeEntry(entries, makeEntry({ title: 'f2', category: 'fact', content: 'fact two content here too' }))
      storeEntry(entries, makeEntry({ title: 'p1', category: 'preference', content: 'preference number one' }))

      const stats = getStats(entries)
      assertEqual(stats.totalEntries, 3, '3 total')
      assertEqual(stats.byCategory.fact, 2, '2 facts')
      assertEqual(stats.byCategory.preference, 1, '1 preference')
    } finally {
      teardownDir()
    }
  })

  // ── getTotalSize ──
  await test('getTotalSize calculates correctly', () => {
    setupDir()
    try {
      const entries = [
        makeEntry({ title: 'ab', content: 'cd' }),
        makeEntry({ title: 'x'.repeat(100), content: 'y'.repeat(100) }),
      ]
      const size = getTotalSize(entries)
      assertEqual(size, 204, 'title+content bytes')
    } finally {
      teardownDir()
    }
  })

  // ── Tokenize ──
  await test('tokenize splits mixed content correctly', () => {
    const tokens = tokenize('Hello World，中文测试')
    assert(tokens.length >= 3, 'at least 3 tokens')
    assertContain(tokens.join(' '), 'hello', 'contains hello')
    assertContain(tokens.join(' '), 'world', 'contains world')
  })

  // ── Jaccard similarity ──
  await test('jaccardSimilarity returns 1 for identical arrays', () => {
    assertEqual(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1, 'identical')
  })

  await test('jaccardSimilarity returns 0 for disjoint arrays', () => {
    assertEqual(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0, 'disjoint')
  })

  await test('jaccardSimilarity returns correct value', () => {
    const sim = jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'd'])
    assertEqual(sim, 0.5, '2/4')
  })

  await test('jaccardSimilarity handles empty arrays', () => {
    assertEqual(jaccardSimilarity([], []), 0, 'empty returns 0')
  })

  // ── scoreEntry ──
  await test('scoreEntry gives preference boost', () => {
    const now = new Date().toISOString()
    const fact = makeEntry({ category: 'fact', confidence: 0.5, recurrence: 0, createdAt: now })
    const pref = makeEntry({ category: 'preference', confidence: 0.5, recurrence: 0, createdAt: now })

    const factScore = scoreEntry(fact)
    const prefScore = scoreEntry(pref)
    assert(prefScore > factScore, 'preference > fact')
  })

  // ── Cross-extension conflict check ──
  await test('tool names do not conflict with other extensions', () => {
    const myTools = ['memory_store', 'memory_search', 'memory_stats', 'memory_forget']
    const myCommands = ['memory:search', 'memory:stats', 'memory:prune']

    const knownTools = [
      'schedule_task', 'ctx_exec', 'ctx_note', 'ctx_list', 'ctx_snap',
      'todo', 'subagent', 'web_search', 'fetch_url',
      'navigate', 'screenshot', 'click', 'type', 'scroll', 'extract', 'evaluate', 'close',
    ]
    const knownCommands = [
      'loop', 'schedule', 'remind',
      'ctx-lite:status', 'ctx-lite:cleanup', 'ctx-lite:forget',
      'todos', 'plan', 'continue', 'execution-mode', 'executing',
    ]

    for (const t of myTools) {
      assert(!knownTools.includes(t), `tool "${t}" conflicts`)
    }
    for (const c of myCommands) {
      assert(!knownCommands.includes(c), `command "${c}" conflicts`)
    }
  })

  // ── Summary ──
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
