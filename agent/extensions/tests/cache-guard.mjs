#!/usr/bin/env node
/**
 * cache-guard — 缓存注入面守门（对齐 Reasonix/Orca 字节级前缀稳定实践）
 *
 * 三件检查：
 *  1. 注入面指纹（HIGH）：对影响 system prompt/注入块的源文件做 sha256，
 *     与基线（cache-guard.baseline.json）比对。任何变化都会改变缓存前缀/注入
 *     序列 → 需显式 --update-baseline 确认（审计该改动对缓存的影响）。
 *  2. 动态内容扫描（MEDIUM）：扫描扩展与共享库源码中的时间/随机源调用
 *     （Date.now/new Date/Math.random/performance.now），列出位置供审计——
 *     这些若出现在 system prompt 注入路径将每轮破坏前缀（禁止）。
 *  3. 阈值契约（HIGH）：lib/prune.ts 的事后修改机制阈值不得低于 2026-08-18
 *     审计值（PRUNE_PROTECT ≥120K、KEEP_THINKING ≥64K）——防回退到
 *     周期性断裂模式；检查分层按需加载仍启用（tool-groups 被 pi-context import）。
 *
 * 用法：node tests/cache-guard.mjs          # 检查（test-all.sh 非 --fast 路径调用）
 *       node tests/cache-guard.mjs --update-baseline   # 改动注入面后显式更新基线
 * 退出码：0 = 通过（或基线已更新）；1 = 指纹漂移/阈值回退（阻断提交）
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..') // agent/
const BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'cache-guard.baseline.json')
const UPDATE = process.argv.includes('--update-baseline')

// ---- 1. 注入面指纹（HIGH）----
// 这些文件的字节内容直接决定 system prompt / 注入块 / 消息变换行为。
// 注意：指纹变化 ≠ 缓存必然破坏（如纯注释改动），但必须显式确认。
const INJECTION_SURFACE = [
  ['AGENTS.md', 'AGENTS.md', 'high'],
  ['pi-context/tool-groups.ts（休眠简介/核心分组）', 'extensions/pi-context/tool-groups.ts', 'high'],
  ['pi-memory/inject.ts（注入头文案）', 'extensions/pi-memory/inject.ts', 'high'],
  ['lib/prune.ts（擦除/剪枝阈值）', 'lib/prune.ts', 'high'],
  ['pi-context/index.ts（注入逻辑/文案）', 'extensions/pi-context/index.ts', 'medium'],
  ['lib/context-budget.ts（截断标记等）', 'lib/context-budget.ts', 'medium'],
  ['subagent/index.ts（delegation 描述）', 'extensions/subagent/index.ts', 'medium'],
  ['pi-context/context-budget.ts（分档注入文案）', 'extensions/pi-context/context-budget.ts', 'medium'],
]

function sha256(s) { return createHash('sha256').update(s).digest('hex') }

const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {}
const current = {}
let drift = 0
let hardFail = 0

for (const [label, relPath, level] of INJECTION_SURFACE) {
  const abs = join(ROOT, relPath)
  const content = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const hash = sha256(content)
  current[label] = hash
  if (!baseline[label]) {
    console.log(`ℹ 基线缺失（首次运行）: ${label}`)
    if (!UPDATE) drift++
  } else if (baseline[label] !== hash) {
    const sev = level === 'high' ? 'HIGH' : 'MED'
    console.log(`⚠ [${sev}] 注入面指纹漂移: ${label}\n      ${baseline[label].slice(0, 12)} → ${hash.slice(0, 12)}\n      （运行 --update-baseline 确认该改动对缓存前缀/注入序列的影响后再提交）`)
    drift++
    if (level === 'high') hardFail++
  }
}

// ---- 2. 动态内容扫描（MEDIUM，仅限注入面文件）----
// 只扫注入面源文件：这些文件的代码拼入 system prompt/注入块/消息变换时，
// 若含动态时间/随机源将每轮破坏前缀。其他扩展（tmux/voice 等）内部的超时
// 计时、存储时间戳不进入注入路径，不计入。
const TIME_PATTERNS = [
  { name: 'Date.now()', re: /Date\.now\s*\(/g },
  { name: 'new Date', re: /new Date\s*\(/g },
  { name: 'toISOString', re: /\.toISOString\s*\(/g },
  { name: 'Math.random', re: /Math\.random\s*\(/g },
  { name: 'performance.now', re: /performance\.now\s*\(/g },
]
let dynHits = 0
for (const [label, relPath] of INJECTION_SURFACE) {
  const abs = join(ROOT, relPath)
  if (!existsSync(abs)) continue
  const content = readFileSync(abs, 'utf8')
  let fileHits = 0
  for (const { name, re } of TIME_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) fileHits++
  }
  if (fileHits > 0) {
    console.log(`  ℹ ${label}: ${fileHits} 处动态时间/随机源——确认均不在注入/拼接路径（记录/计时用途可接受）`)
    dynHits += fileHits
  }
}
console.log(dynHits > 0 ? `  （注入面共 ${dynHits} 处动态源，白名单：usage-diag 记录/内部计时——非注入拼接）` : '  ✓ 注入面无动态时间/随机源')

// ---- 3. 阈值契约（HIGH）----
const pruneSrc = readFileSync(join(ROOT, 'lib/prune.ts'), 'utf8')
const num = (s) => Number(String(s).replace(/[,_]/g, ''))
const protect = num((pruneSrc.match(/PRUNE_PROTECT_TOKENS\s*=\s*(\d[\d_]*)/) || [])[1] || 0)
const mind = num((pruneSrc.match(/PRUNE_MINIMUM_TOKENS\s*=\s*(\d[\d_]*)/) || [])[1] || 0)
const thinking = num((pruneSrc.match(/DEFAULT_KEEP_THINKING_TOKENS\s*=\s*(\d[\d_]*)/) || [])[1] || 0)
console.log(`  阈值: PRUNE_PROTECT=${protect} (≥120K ${protect >= 120_000 ? '✓' : '✗'}) | PRUNE_MINIMUM=${mind} (≥80K ${mind >= 80_000 ? '✓' : '✗'}) | KEEP_THINKING=${thinking} (≥64K ${thinking >= 64_000 ? '✓' : '✗'})`)
if (protect < 120_000 || mind < 80_000 || thinking < 64_000) {
  console.log('  ✗ 阈值回退——post-hoc 消息修改将恢复周期性缓存断裂（2026-08-18 审计：16K 时 27 次断裂/3.8h、1.46M token 浪费）')
  hardFail++
}

// ---- 结果 ----
if (UPDATE) {
  writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + '\n')
  console.log(`\n已更新基线 → ${BASELINE_FILE}`)
  process.exit(0)
}
const dynNote = dynHits > 0 ? 1 : 0 // 动态源需人工确认，警告不阻断
if (hardFail > 0) {
  console.log(`\n✗ cache-guard 失败（${hardFail} 项 HIGH 漂移/阈值回退）`)
  process.exit(1)
}
if (drift > 0) {
  console.log(`\n⚠ cache-guard 漂移（${drift} 项未确认）——若已审计缓存影响，运行 --update-baseline 固化；未审计前建议不提交注入面改动`)
  process.exit(drift > 0 && dynNote ? 1 : 0)
}
console.log('\n✓ cache-guard 通过：注入面稳定、阈值合规')
process.exit(0)