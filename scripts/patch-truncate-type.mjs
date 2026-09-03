#!/usr/bin/env node
/**
 * @target-version 0.84
 * patch-truncate-type.mjs — Fix TypeError in truncateToWidth (幂等)
 *
 * Bug: truncateToWidth(text, maxWidth) calls text.slice/text.length but
 * some autocomplete items pass non-string values, causing
 * "TypeError: text.slice is not a function" crash.
 *
 * Fix: Guard text with typeof check; return empty string for non-string.
 *
 * Usage: node patch-truncate-type.mjs [dist directory]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MARKER = 'Patch (patch-truncate-type.mjs)'
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

const target = join(detectDist(), '..', 'node_modules', '@earendil-works', 'pi-tui', 'dist', 'utils.js')
if (!existsSync(target)) {
  console.error(`Not found: ${target}`)
  process.exit(1)
}

let src = readFileSync(target, 'utf-8')

if (src.includes(MARKER)) {
  console.log(`Already patched, skipping: ${target}`)
  process.exit(0)
}

// Original code (line 952):
//   export function truncateToWidth(text, maxWidth, ellipsis = "...", pad = false) {
//       if (maxWidth <= 0) {
const needle =
  'export function truncateToWidth(text, maxWidth, ellipsis = "...", pad = false) {\n' +
  '    if (maxWidth <= 0) {'

if (!src.includes(needle)) {
  console.error(`Pattern not found in ${target} — pi-tui version may have changed`)
  process.exit(1)
}

const replacement =
  '// Patch (patch-truncate-type.mjs): guard non-string text\n' +
  'export function truncateToWidth(text, maxWidth, ellipsis = "...", pad = false) {\n' +
  '    if (typeof text !== "string") {\n' +
  '        return pad ? " ".repeat(Math.max(0, maxWidth)) : "";\n' +
  '    }\n' +
  '    if (maxWidth <= 0) {'

const patched = src.replace(needle, replacement)

if (DRY_RUN) { console.log(`dry-run: pattern found in ${target}, not writing`); process.exit(0) }
writeFileSync(target, patched, 'utf-8')
console.log(`Patch applied: ${target}`)
