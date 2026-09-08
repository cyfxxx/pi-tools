#!/usr/bin/env node
/**
 * memory-lifecycle — 记忆生命周期治理报告（VISION P4 / ROADMAP 4.4，2026-08-26）
 *
 * 目的：记忆库只进不出会推高注入成本并稀释相关性；错误教训入库会自我强化。
 *       本脚本按 VISION §5 规则产出三类候选清单，供会话/autopilot 裁决：
 *
 *   1. 淘汰候选：未删除 且 recurrence≤1 且 accessedAt >180 天 且 confidence<0.7
 *      → 批量删除必须用户确认（授权边界），确认后用 pi-memory 工具逐条删除
 *   2. 升格候选：solutions/fact 类 且 recurrence≥5 且非垃圾嫌疑
 *      → 进入 VISION §3.1 单向升格通道评估（记忆→提示词规则→扩展逻辑/守门测试）
 *   3. 冲突嫌疑：标题归一化后重复（近似主题多条目）
 *      → 由会话裁决合并/去重
 *   4. 垃圾嫌疑：content 无实义（归一化 <30 字符）或标题为测试噪声词
 *      → 列出供裁决删除；不进升格候选（2026-08-29：修复 "test" rec=34 混入升格候选）
 *   5. 聚合候选（ExpeL 归纳升级，2026-08-29 ROADMAP 5.5）：同主题经验（solutions/procedure）
 *      标题 bigram-jaccard 聚类，组内 ≥3 条且 Σrecurrence≥8
 *      → 建议归纳为单条规则（confidence 0.7），旧条目 superseded 指向新条目；
 *        本脚本只报告，执行走既有“报告→确认→快照→执行”流程，不直接改库
 *
 * 数据源：~/.pi/memory/entries.json（PI_HOME 覆盖仓库根）
 * 幂等：纯只读，无副作用。写操作永远走"报告→确认→快照→执行→验证"。
 *
 * 用法：
 *   node scripts/memory-lifecycle.mjs               # 人读报告（每类默认列前 15 条）
 *   node scripts/memory-lifecycle.mjs --limit N     # 每类展开条数
 *   node scripts/memory-lifecycle.mjs --json        # 机器可读
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REPO_ROOT = process.env.PI_HOME || join(homedir(), '.pi')
const ENTRIES = join(REPO_ROOT, 'memory', 'entries.json')
const STALE_DAYS = 180
const PROMOTE_MIN = 5

const args = process.argv.slice(2)
function usage() {
  console.log(`用法: node scripts/memory-lifecycle.mjs [--limit N] [--json]
  --limit N   每类候选展开条数（默认 15）
  --json      输出 JSON（供 autopilot 每日自检消费）
  规则: VISION §5 —— 淘汰(recurrence≤1 & accessedAt>${STALE_DAYS}d & confidence<0.7)
        升格(solutions|fact & recurrence≥${PROMOTE_MIN}) 冲突(标题归一化重复)`)
}
if (args.includes('-h') || args.includes('--help')) { usage(); process.exit(0) }
const AS_JSON = args.includes('--json')
let LIMIT = 15
const li = args.indexOf('--limit')
if (li >= 0 && args[li + 1]) {
  const n = parseInt(args[li + 1], 10)
  if (Number.isFinite(n) && n >= 0) LIMIT = n
}

if (!existsSync(ENTRIES)) {
  console.log(AS_JSON ? JSON.stringify({ ok: false, reason: 'no-entries-file' }) : '暂无数据')
  process.exit(0)
}
let entries = []
try {
  const data = JSON.parse(readFileSync(ENTRIES, 'utf8'))
  entries = Array.isArray(data) ? data : data.entries ?? []
} catch {
  console.log(AS_JSON ? JSON.stringify({ ok: false, reason: 'entries-parse-error' }) : '✗ entries.json 解析失败')
  process.exit(1)
}

const now = Date.now()
const live = entries.filter(e => e && !e.deleted)
const ageDays = e => (now - new Date(e.accessedAt || e.updatedAt || e.createdAt).getTime()) / 86400000

// ---- 1. 淘汰候选 ----
const stale = live.filter(e =>
  (e.recurrence ?? 0) <= 1 &&
  ageDays(e) > STALE_DAYS &&
  (e.confidence ?? 1) < 0.7,
).map(e => ({ id: e.id, title: e.title, category: e.category, recurrence: e.recurrence ?? 0, confidence: e.confidence ?? null, idleDays: Math.round(ageDays(e)) }))

// ---- 1.5 垃圾嫌疑（2026-08-29：噪声条目混入升格候选缺陷修复）----
const NOISE_TITLE_RE = /^(test|testing|测试|hello|hi|aaa|foo|bar|demo|tmp|temp)$/i
function junkReason(e) {
  const content = String(e.content || '').replace(/\s+/gu, '')
  if (content.length < 30) return 'content 无实义（归一化后 <30 字符）'
  if (NOISE_TITLE_RE.test(String(e.title || '').trim())) return '标题为测试噪声词'
  return null
}
const junk = live
  .map(e => ({ id: e.id, title: e.title, category: e.category, recurrence: e.recurrence ?? 0, reason: junkReason(e) }))
  .filter(e => e.reason)

// ---- 2. 升格候选 ----
const promote = live.filter(e =>
  ['solutions', 'fact'].includes(e.category) &&
  (e.recurrence ?? 0) >= PROMOTE_MIN &&
  !junkReason(e),
).map(e => ({ id: e.id, title: e.title, category: e.category, recurrence: e.recurrence ?? 0 })).sort((a, b) => b.recurrence - a.recurrence)

// ---- 3. 冲突嫌疑（标题归一化重复）----
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 24)
}
const groups = new Map()
for (const e of live) {
  const k = normTitle(e.title)
  if (k.length < 8) continue // 过短标题误报高
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push({ id: e.id, title: e.title, category: e.category })
}
const conflicts = [...groups.values()].filter(g => g.length > 1)

// ---- 3.5 聚合候选（ExpeL 归纳升级，ROADMAP 5.5）----
const AGG_MIN_MEMBERS = 3   // 组内最少条数
const AGG_MIN_SUM_REC = 8   // 组内 Σrecurrence 门槛
const AGG_SIM = 0.34        // 标题 bigram-jaccard 阈值（中文 bigram 稀疏，阈值放宽）
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
const jacc = (a, b) => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}
const expEntries = live.filter(e => ['solutions', 'procedure'].includes(e.category) && !junkReason(e))
const bg = expEntries.map(e => ({ e, g: bigrams(e.title) }))
const parent = bg.map((_, i) => i)
const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])))
for (let i = 0; i < bg.length; i++)
  for (let j = i + 1; j < bg.length; j++)
    if (jacc(bg[i].g, bg[j].g) >= AGG_SIM) parent[find(i)] = find(j)
const aggMap = new Map()
bg.forEach((x, i) => {
  const r = find(i)
  if (!aggMap.has(r)) aggMap.set(r, [])
  aggMap.get(r).push(x.e)
})
const aggregation = [...aggMap.values()]
  .map(members => ({
    size: members.length,
    sumRecurrence: members.reduce((a, e) => a + (e.recurrence ?? 0), 0),
    members: members.map(e => ({ id: e.id, title: e.title, category: e.category, recurrence: e.recurrence ?? 0, confidence: e.confidence ?? null })),
  }))
  .filter(g => g.size >= AGG_MIN_MEMBERS && g.sumRecurrence >= AGG_MIN_SUM_REC)
  .sort((a, b) => b.sumRecurrence - a.sumRecurrence)

// ---- 输出 ----
if (AS_JSON) {
  console.log(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    totalEntries: live.length,
    rules: { staleDays: STALE_DAYS, promoteMinRecurrence: PROMOTE_MIN, aggMinMembers: AGG_MIN_MEMBERS, aggMinSumRecurrence: AGG_MIN_SUM_REC, aggSim: AGG_SIM },
    counts: { staleCandidates: stale.length, promotionCandidates: promote.length, conflictGroups: conflicts.length, junkSuspects: junk.length, aggregationCandidates: aggregation.length },
    staleCandidates: LIMIT === 0 ? stale : stale.slice(0, LIMIT),
    promotionCandidates: LIMIT === 0 ? promote : promote.slice(0, LIMIT),
    conflictGroups: LIMIT === 0 ? conflicts : conflicts.slice(0, LIMIT),
    junkSuspects: LIMIT === 0 ? junk : junk.slice(0, LIMIT),
    aggregationCandidates: LIMIT === 0 ? aggregation : aggregation.slice(0, LIMIT),
  }, null, 2))
  process.exit(0)
}

console.log('══ 记忆生命周期治理报告 ══')
console.log(`有效条目 ${live.length}/${entries.length} | 规则: 淘汰(${STALE_DAYS}天冷+低置信+零复现) 升格(recurrence≥${PROMOTE_MIN} 的 solutions/fact，非垃圾) 冲突(标题重复) 垃圾(content 无实义/噪声标题) 聚合(≥${AGG_MIN_MEMBERS}条同主题且Σrec≥${AGG_MIN_SUM_REC})`)
console.log('')
console.log(`[淘汰候选] ${stale.length} 条（批量删除须用户确认；先快照 entries.json）`)
for (const e of stale.slice(0, LIMIT)) console.log(`  - [${e.category}] ${e.title}  (rec=${e.recurrence}, conf=${e.confidence}, 冷${e.idleDays}天)`)
if (stale.length > LIMIT) console.log(`  … 其余 ${stale.length - LIMIT} 条见 --json`)
console.log('')
console.log(`[升格候选] ${promote.length} 条（VISION §3.1 单向升格通道：记忆→提示词规则→扩展逻辑/守门测试→原软引导降权）`)
for (const e of promote.slice(0, LIMIT)) console.log(`  - [${e.category}] ${e.title}  (rec=${e.recurrence})`)
if (promote.length > LIMIT) console.log(`  … 其余 ${promote.length - LIMIT} 条见 --json`)
console.log('')
console.log(`[聚合候选] ${aggregation.length} 组（ExpeL 归纳升级：同主题经验→单条规则 conf=0.7，旧条目 superseded；执行走确认流程）`)
for (const g of aggregation.slice(0, LIMIT)) {
  console.log(`  组（${g.size}条/Σrec=${g.sumRecurrence}）:`)
  for (const e of g.members.slice(0, 6)) console.log(`    - [${e.category}] ${e.title}  (rec=${e.recurrence}, conf=${e.confidence})`)
  if (g.members.length > 6) console.log(`    … 其余 ${g.members.length - 6} 条见 --json`)
}
if (aggregation.length > LIMIT) console.log(`  … 其余 ${aggregation.length - LIMIT} 组见 --json`)
console.log('')
console.log(`[冲突嫌疑] ${conflicts.length} 组（由会话裁决合并）`)
for (const g of conflicts.slice(0, LIMIT)) {
  console.log(`  组「${g[0].title.slice(0, 20)}…」:`)
  for (const e of g) console.log(`    - [${e.category}] ${e.title}`)
}
if (conflicts.length > LIMIT) console.log(`  … 其余 ${conflicts.length - LIMIT} 组见 --json`)
console.log('')
console.log(`[垃圾嫌疑] ${junk.length} 条（删除须用户确认；先快照 entries.json）`)
for (const e of junk.slice(0, LIMIT)) console.log(`  - [${e.category}] ${e.title}  (rec=${e.recurrence}, 原因: ${e.reason})`)
if (junk.length > LIMIT) console.log(`  … 其余 ${junk.length - LIMIT} 条见 --json`)
