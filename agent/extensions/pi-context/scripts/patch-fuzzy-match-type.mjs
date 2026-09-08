#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-fuzzy-match-type.mjs — Fix TypeError in fuzzyMatch (幂等)
 *
 * Bug: fuzzyMatch(query, text) calls text.toLowerCase() but some
 * autocomplete items return non-string values (undefined/null/object),
 * causing "TypeError: text.toLowerCase is not a function" crash.
 *
 * Fix: Guard both query and text with typeof checks; return no-match
 * for non-string values.
 *
 * Usage: node patch-fuzzy-match-type.mjs [dist directory]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-fuzzy-match-type.mjs)'
const DRY_RUN = process.env.PATCH_DRY_RUN === '1'

function detectDist() {
  const explicit = process.argv[2]
  if (explicit) return explicit
  if (process.env.PI_DIST && existsSync(process.env.PI_DIST)) return process.env.PI_DIST
  try {
    const bin = execFileSync('which', ['pi'], { encoding: 'utf-8' }).trim()
    if (bin) {
      const resolved = execFileSync('readlink', ['-f', bin], { encoding: 'utf-8' }).trim()
      const m = resolved.match(/(.*node_modules\/@earendil-works\/pi-coding-agent\/)/)
      if (m && existsSync(join(m[1], 'dist'))) return join(m[1], 'dist')
    }
  } catch {}
  const root = join(process.env.HOME || '', '.local', 'share', 'pi-node')
  const candidates = []
  try {
    readdirSync(root)
      .filter(d => d.startsWith('node-v'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach(d => {
        const p = join(root, d, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
        if (existsSync(p)) candidates.push(p)
      })
  } catch {}
  if (candidates.length) return candidates[candidates.length - 1]
  throw new Error('Cannot locate pi dist directory')
}

const target = join(detectDist(), '..', 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'fuzzy.js')
if (!existsSync(target)) {
  console.error(`Not found: ${target}`)
  process.exit(1)
}

let src = readFileSync(target, 'utf-8')

if (src.includes(MARKER)) {
  console.log(`Already patched, skipping: ${target}`)
  process.exit(0)
}

// Original code (line 6-8):
//   export function fuzzyMatch(query, text) {
//       const queryLower = query.toLowerCase();
//       const textLower = text.toLowerCase();
const needle =
  'export function fuzzyMatch(query, text) {\n' +
  '    const queryLower = query.toLowerCase();\n' +
  '    const textLower = text.toLowerCase();'

if (!src.includes(needle)) {
  console.error(`Pattern not found in ${target} — pi-tui version may have changed`)
  process.exit(1)
}

const replacement =
  '// Patch (patch-fuzzy-match-type.mjs): guard non-string inputs\n' +
  'export function fuzzyMatch(query, text) {\n' +
  '    if (typeof query !== "string" || typeof text !== "string") {\n' +
  '        return { matches: false, score: 0 };\n' +
  '    }\n' +
  '    const queryLower = query.toLowerCase();\n' +
  '    const textLower = text.toLowerCase();'

const patched = src.replace(needle, replacement)

if (DRY_RUN) { console.log(`dry-run: pattern found in ${target}, not writing`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`Patch applied: ${target}`)
