#!/usr/bin/env node
/**
 * Cross-extension conflict detection.
 * Scans all extension source files to detect:
 * 1. Duplicate tool/command/event/flag names
 * 2. Shared data directory collisions
 * 3. Environment variable naming conventions
 * 4. Import path correctness for shared libs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXTENSIONS_DIR = join(fileURLToPath(new URL('..', import.meta.url)))
const EXT_NAMES = readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'tests' && d.name !== 'types' && d.name !== 'node_modules' && d.name !== 'pi-web-toolkit')
  .map(d => d.name)

// Also include pi-web-toolkit separately
const ALL_EXTENSIONS = [...EXT_NAMES, 'pi-web-toolkit'].sort()

const TOOL_PATTERN = /registerTool\s*\(\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"]/g
const CMD_PATTERN = /registerCommand\s*\(\s*['"]([^'"]+)['"]/g
const EVENT_PATTERN = /pi\.on\s*\(\s*['"]([^'"]+)['"]/g
const FLAG_PATTERN = /registerFlag\s*\(\s*['"]([^'"]+)['"]/g

function scanFile(filePath, patterns) {
  if (!existsSync(filePath) || filePath.endsWith('.d.ts')) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    const results = []
    for (const { name, re } of patterns) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(content)) !== null) {
        results.push({ type: name, value: m[1], file: relative(EXTENSIONS_DIR, filePath) })
      }
    }
    return results
  } catch {
    return []
  }
}

function scanExtension(dir) {
  const results = []
  const patterns = [
    { name: 'tool', re: TOOL_PATTERN },
    { name: 'command', re: CMD_PATTERN },
    { name: 'event', re: EVENT_PATTERN },
    { name: 'flag', re: FLAG_PATTERN },
  ]

  function walk(d) {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'tests') walk(p)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        results.push(...scanFile(p, patterns))
      }
    }
  }
  walk(dir)
  return results
}

let passed = 0
let failed = 0
const failures = []

function assert(cond, msg) {
  if (!cond) { throw new Error(msg) }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  \u2713 ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  \u2717 ${name}: ${e.message}`)
  }
}

async function main() {
  console.log('cross-extension conflict check\n')

  // ── Gather all registrations ──
  const all = {}
  for (const ext of ALL_EXTENSIONS) {
    all[ext] = scanExtension(join(EXTENSIONS_DIR, ext))
  }

  // ── 1. Tool name uniqueness ──
  await test('no duplicate tool names across extensions', () => {
    const toolMap = {}
    for (const [ext, items] of Object.entries(all)) {
      for (const item of items) {
        if (item.type !== 'tool') continue
        if (toolMap[item.value]) {
          throw new Error(`Tool "${item.value}" registered by "${toolMap[item.value]}" and "${ext}"`)
        }
        toolMap[item.value] = ext
      }
    }
    const expected = [
      'admin_status', 'admin_list_models', 'admin_set_model', 'admin_get_config',
      'admin_set_config', 'admin_list_sessions', 'admin_switch_session', 'admin_restart',
      'memory_store', 'memory_search', 'memory_stats', 'memory_forget',
      'schedule_task', 'ctx_exec', 'ctx_note', 'ctx_list', 'ctx_snap',
      'todo', 'task', 'subagent',
      'web_search', 'fetch_url', 'web_fetch',
      'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
      'browser_scroll', 'browser_extract', 'browser_evaluate', 'browser_close',
    ]
    const actual = Object.keys(toolMap).sort()
    assertEqual(actual.length, expected.length, 'tool count')
    for (const t of expected) {
      assert(toolMap[t], `tool "${t}" not found in any extension`)
    }
  })

  // ── 2. Command name uniqueness ──
  await test('no duplicate command names across extensions', () => {
    const cmdMap = {}
    for (const [ext, items] of Object.entries(all)) {
      for (const item of items) {
        if (item.type !== 'command') continue
        if (cmdMap[item.value]) {
          throw new Error(`Command "${item.value}" registered by "${cmdMap[item.value]}" and "${ext}"`)
        }
        cmdMap[item.value] = ext
      }
    }
    const expected = [
      'admin:status', 'admin:restart', 'admin:session', 'admin:model', 'admin:config',
      'memory:search', 'memory:stats', 'memory:prune',
      'loop', 'remind', 'schedule',
      'ctx-lite:status', 'ctx-lite:cleanup', 'ctx-lite:forget',
      'plan', 'plandiff', 'planqa', 'todos',
    ]
    const actual = Object.keys(cmdMap).sort()
    for (const c of expected) {
      assert(cmdMap[c], `command "${c}" not found in any extension`)
    }
  })

  // ── 3. Event name analysis ──
  await test('event handler registration (cross-extension listeners)', () => {
    const eventMap = {}
    for (const [ext, items] of Object.entries(all)) {
      for (const item of items) {
        if (item.type !== 'event') continue
        if (!eventMap[item.value]) eventMap[item.value] = []
        eventMap[item.value].push(ext)
      }
    }

    // Log shared events
    const shared = Object.entries(eventMap).filter(([, v]) => v.length > 1)
    const sharedStr = shared.map(([e, v]) => `  "${e}": [${v.join(', ')}]`).join('\n')
    if (sharedStr) {
      console.log(`  \u2139 Events with multiple listeners:\n${sharedStr}`)
    }

    // Check critical shared events have expected listeners
    const expectedListeners = {
      'session_start': ['pi-admin', 'pi-scheduler', 'pi-memory', 'pi-web-toolkit', 'ctx-lite', 'plan-mode'],
      'session_shutdown': ['pi-scheduler', 'pi-memory', 'pi-web-toolkit', 'plan-mode'],
      'before_agent_start': ['pi-router', 'pi-memory', 'plan-mode'],
      'context': ['pi-context-efficiency', 'pi-memory', 'plan-mode'],
      'tool_call': ['plan-mode'],
      'tool_result': ['pi-context-efficiency'],
      'message_end': ['pi-context-efficiency'],
      'input': ['pi-context-efficiency'],
      'turn_end': ['plan-mode'],
      'agent_end': ['plan-mode'],
      'agent_start': ['plan-mode'],
      'session_compact': ['pi-web-toolkit', 'plan-mode'],
      'session_tree': ['plan-mode'],
      'session_before_compact': ['ctx-lite'],
      'tool_execution_end': ['plan-mode'],
    }
    for (const [ev, exts] of Object.entries(expectedListeners)) {
      const actualExts = eventMap[ev] || []
      for (const e of exts) {
        assert(actualExts.includes(e), `Expected "${e}" to listen to "${ev}", but found: [${actualExts.join(', ')}]`)
      }
    }
  })

  // ── 4. Environment variable naming convention ──
  await test('environment variable naming convention (PI_WEB_TOOLKIT_* isolation)', () => {
    const envMap = {}
    for (const [ext, items] of Object.entries(all)) {
      for (const item of items) {
        const m = item.file ? item.file.match(/^[^/]+/) : null
        const prefix = m ? m[0] : ext

        // Scan file content for env var patterns
        const filePath = join(EXTENSIONS_DIR, item.file)
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        const envVars = content.match(/process\.env\.\w+/g) || []
        for (const ev of envVars) {
          const varName = ev.replace('process.env.', '')
          if (envMap[varName] && envMap[varName] !== prefix) {
            console.log(`  \u26a0 Env var "${varName}" used by "${envMap[varName]}" and "${prefix}"`)
          }
          envMap[varName] = prefix
        }
      }
    }

    // Verify pi-web-toolkit env vars have correct prefix
    for (const [varName, ext] of Object.entries(envMap)) {
      if (ext === 'pi-web-toolkit') {
        assert(
          varName.startsWith('PI_WEB_TOOLKIT_') || varName.startsWith('HOME') || varName === 'NODE_ENV',
          `pi-web-toolkit env var "${varName}" should start with PI_WEB_TOOLKIT_`
        )
      }
    }
  })

  // ── 5. Shared lib import path correctness ──
  await test('shared library import paths are correct', () => {
    const extDirs = ALL_EXTENSIONS.map(e => join(EXTENSIONS_DIR, e))
    const sharedLib = join(EXTENSIONS_DIR, '..', 'lib')

    for (const dir of extDirs) {
      if (!existsSync(dir)) continue
      function walk(d) {
        let entries
        try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const p = join(d, e.name)
          if (e.isDirectory()) {
            if (e.name !== 'node_modules' && e.name !== 'tests') walk(p)
          } else if (e.name.endsWith('.ts')) {
            const content = readFileSync(p, 'utf-8')
            const importMatches = content.matchAll(/from\s+['"]\.\.\/\.\.\/lib\/([^'"]+)['"]/g)
            for (const m of importMatches) {
              const libPath = join(sharedLib, m[1])
              assert(existsSync(libPath), `Missing lib import: ${m[0]} in ${relative(EXTENSIONS_DIR, p)}`)
            }
          }
        }
      }
      walk(dir)
    }
  })

  // ── 6. Data directory isolation ──
  await test('data directories do not overlap across extensions', () => {
    const dataDirs = {}
    for (const [ext, items] of Object.entries(all)) {
      for (const item of items) {
        const filePath = join(EXTENSIONS_DIR, item.file)
        if (!existsSync(filePath)) continue
        const content = readFileSync(filePath, 'utf-8')
        const dirMatches = content.matchAll(/['"]([^'"]*\.pi\/(?:memory|scheduler|ctx-lite|searxng)[^'"]*)['"]/g)
        for (const m of dirMatches) {
          const dir = m[1]
          if (dataDirs[dir] && dataDirs[dir] !== ext) {
            console.log(`  \u26a0 Data dir "${dir}" used by "${dataDirs[dir]}" and "${ext}"`)
          }
          dataDirs[dir] = ext
        }
      }
    }
  })

  // ── Summary ──
  const total = passed + failed
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`)
    }
    process.exit(1)
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
