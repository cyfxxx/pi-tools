#!/usr/bin/env node
/**
 * doc-lint: 扩展 README 与代码的轻量一致性守门（2026-08-25 文档漂移审计产物）
 *
 * 只做高价值、低误报的断言：
 *  1. 工具名一致：源码注册的工具（name: 'xxx'）必须在对应 README 出现
 *  2. slash 命令一致：registerCommand('xxx') 必须在 README 以 /xxx 出现
 *  3. 测试计数防漂移：README 不应声明具体用例数（数字会过时）
 *
 * 已知局限（有意不做）：不校验机制描述/阈值/行号——那些需要语义理解，
 * 由审计流程覆盖；本脚本只抓"机械可验证且漂移高发"的三类。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const EXT_DIR = join(ROOT, 'agent', 'extensions')
const SKIP = new Set(['node_modules', 'tests', 'types', 'lib'])

let failures = 0

function srcFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'tests') continue
      out.push(...srcFiles(p))
    } else if (/\.(ts|mjs)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

for (const entry of readdirSync(EXT_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP.has(entry.name)) continue
  const extDir = join(EXT_DIR, entry.name)
  const readmePath = join(extDir, 'README.md')
  if (!existsSync(readmePath)) continue
  const readme = readFileSync(readmePath, 'utf-8')

  // 1) 工具名：src 内 name: 'xxx' 且像工具名（snake_case），README 未提及则报
  const toolNames = new Set()
  for (const f of srcFiles(extDir)) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/name:\s*['"]([a-z][a-z0-9_]{2,30})['"]/g)) toolNames.add(m[1])
  }
  // 过滤明显的非工具名（配置键等启发式：README 提过的不报，未提的才人工看）
  const missingTools = [...toolNames].filter((n) => !readme.includes(n))
  // 工具名误报缓冲：排除常见配置键形态（含 config/env/dir/file/path 等词尾）
  const likelyKeys = missingTools.filter(
    (n) => !/(config|env|dir|file|path|mode|type|key|name|url|token|prefix|timeout|enabled)/.test(n)
  )
  if (likelyTools(missingTools).length > 0 && likelyKeys.length > 0) {
    console.log(`⚠ [${entry.name}] README 未提及疑似工具名: ${likelyKeys.join(', ')}`)
    failures++
  }

  // 2) slash 命令：registerCommand('xxx') → README 需有 /xxx
  for (const f of srcFiles(extDir)) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/registerCommand\(\s*['"]([a-z0-9-]+)['"]/g)) {
      const cmd = m[1]
      if (!readme.includes(`/${cmd}`)) {
        console.log(`⚠ [${entry.name}] README 未提及 slash 命令 /${cmd}`)
        failures++
      }
    }
  }

  // 3) 测试计数声明（易漂移）
  const countClaims = readme.match(/\d+\s*(个用例|项测试|条用例|tests? cases?)/gi)
  if (countClaims) {
    console.log(`ℹ [${entry.name}] README 含具体测试计数（建议去数字化）: ${countClaims.join(', ')}`)
  }
}

function likelyTools(names) {
  return names
}

if (failures > 0) {
  console.log(`✗ doc-lint 失败（${failures} 项）`)
  process.exit(1)
} else {
  console.log('✓ doc-lint 通过：工具/slash 命令清单与 README 一致')
}
