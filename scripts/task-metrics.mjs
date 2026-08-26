#!/usr/bin/env node
/**
 * task-metrics — 任务级遥测聚合（VISION P2 / ROADMAP 4.2，2026-08-26）
 *
 * 目的：把轮级用量（usage-diag）与干预事件（pi-intervention 快照）聚合成
 *       会话级指标：成功率代理、干预次数、token 成本、缓存健康。为"进化"
 *       提供度量基线——没有度量就无法证明任何改动是进步。
 *
 * 数据源：
 *   - ~/.pi/agent/.usage-diag.jsonl（pi-context 每轮 turn_end 记录；PI_AGENT_DIR 覆盖）
 *   - ~/.pi/memory/interventions.jsonl（pi-intervention abort 快照；PI_INTERVENTIONS_FILE 覆盖）
 *
 * 会话分段（与 lesson-miner.mjs 同口径）：
 *   - 时间间隔 >8min → 新会话
 *   - contextTokens 较上轮回落 >60% → 会话重建
 *
 * 成功代理判定（单会话"干净"）：
 *   干预次数 =0 且 命中率 ≥90% 且 断裂(A+B) ≤3 且 浪费 ≤300K
 *   （代理指标，非真值；任务语义级成功需 LLM 判定，暂不引入）
 *
 * 用法：
 *   node scripts/task-metrics.mjs                # 人读摘要（近 10 会话 + 总体）
 *   node scripts/task-metrics.mjs --limit N      # 展开近 N 个会话明细
 *   node scripts/task-metrics.mjs --json         # 机器可读（golden-tasks --fast 消费）
 *   PI_AGENT_DIR=... PI_INTERVENTIONS_FILE=...   # 数据源覆盖
 *
 * 幂等：纯只读，无副作用。数据缺失优雅降级（退出码 0）。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent')
const DIAG = join(BASE, '.usage-diag.jsonl')
const REPO_ROOT = process.env.PI_HOME || join(homedir(), '.pi')
const INTERVENTIONS = process.env.PI_INTERVENTIONS_FILE || join(REPO_ROOT, 'memory', 'interventions.jsonl')

const HIT_HEALTHY = 0.90
const BREAKS_OK = 3
const WASTE_OK = 300_000
const SESSION_GAP_MS = 8 * 60 * 1000

const args = process.argv.slice(2)
function usage() {
  console.log(`用法: node scripts/task-metrics.mjs [--limit N] [--json]
  --limit N   会话明细展开数量（默认人读模式 10，--json 时全部）
  --json      输出 JSON（供 golden-tasks/autopilot 消费）
  环境变量: PI_AGENT_DIR（usage-diag 基线）、PI_INTERVENTIONS_FILE（干预快照）`)
}
if (args.includes('-h') || args.includes('--help')) { usage(); process.exit(0) }
const AS_JSON = args.includes('--json')
let LIMIT = 10
if (!AS_JSON) {
  const li = args.indexOf('--limit')
  if (li >= 0 && args[li + 1]) {
    const n = parseInt(args[li + 1], 10)
    if (Number.isFinite(n) && n > 0) LIMIT = n
  }
} else {
  const li = args.indexOf('--limit')
  if (li >= 0 && args[li + 1]) {
    const n = parseInt(args[li + 1], 10)
    if (Number.isFinite(n) && n > 0) LIMIT = n
  } else LIMIT = Infinity
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

// ---- 加载 ----
const turnsAll = readJsonl(DIAG)
const turns = turnsAll.filter(r => Number.isFinite(r.input) && Number.isFinite(r.cacheRead))
const interventions = readJsonl(INTERVENTIONS).filter(r => r.type === 'abort' && r.ts)

if (turns.length === 0) {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, reason: 'no-usage-diag-data' }))
  else { console.log('暂无数据'); console.error(`（usage-diag 不存在或无用量轮: ${DIAG}）`) }
  process.exit(0)
}

// ---- 会话分段 ----
const sessions = []
let cur = null
for (const r of turns) {
  const ts = r.ts
  const ctx = r.contextTokens
  const isNew = !cur ||
    (ts - cur.lastTs) > SESSION_GAP_MS ||
    (cur.lastCtx !== null && ctx < cur.lastCtx * 0.4)
  if (isNew) {
    cur = { startTs: ts, lastTs: ts, lastCtx: ctx, rounds: 0, input: 0, cacheRead: 0, waste: 0, breaksAB: 0, prevCacheRead: null }
    sessions.push(cur)
  }
  cur.lastTs = ts
  cur.lastCtx = ctx
  cur.rounds++
  cur.input += r.input
  cur.cacheRead += r.cacheRead
  if (cur.prevCacheRead !== null && r.cacheRead < cur.prevCacheRead - 100 && r.input > 10_000) {
    const cls = cur.rounds <= 5 ? 'C' : (r.cacheRead <= (r.contextTokens * 0.1) && r.contextTokens > 0 ? 'A' : 'B')
    if (cls !== 'C') {
      cur.breaksAB++
      cur.waste += r.input + Math.max(0, cur.prevCacheRead - r.cacheRead)
    }
  }
  cur.prevCacheRead = r.cacheRead
}

// ---- 干预归属（快照 ts 落在会话窗口 ±60s 内）----
const ivBySession = new Array(sessions.length).fill(0)
for (const iv of interventions) {
  const t = new Date(iv.ts).getTime()
  if (!Number.isFinite(t)) continue
  for (let i = 0; i < sessions.length; i++) {
    if (t >= sessions[i].startTs - 60_000 && t <= sessions[i].lastTs + 60_000) { ivBySession[i]++; break }
  }
}

// ---- 会话指标与成功代理 ----
const rows = sessions.map((s, i) => {
  const denom = s.input + s.cacheRead
  const hitRate = denom > 0 ? s.cacheRead / denom : null
  const clean = ivBySession[i] === 0 &&
    (hitRate === null || hitRate >= HIT_HEALTHY) &&
    s.breaksAB <= BREAKS_OK &&
    s.waste <= WASTE_OK
  return {
    start: new Date(s.startTs).toISOString().replace('T', ' ').slice(0, 16),
    minutes: Math.max(1, Math.round((s.lastTs - s.startTs) / 60000)),
    rounds: s.rounds,
    kTokens: Math.round(denom / 1000),
    hitRate: hitRate === null ? null : +(hitRate * 100).toFixed(1),
    breaksAB: s.breaksAB,
    wasteK: Math.round(s.waste / 1000),
    interventions: ivBySession[i],
    clean,
  }
})

const total = rows.length
const cleanCount = rows.filter(r => r.clean).length
const totalInterventions = rows.reduce((a, r) => a + r.interventions, 0)
const linkedInterventions = interventions.filter(r => r.correctivePrompt).length
const aggTokens = rows.reduce((a, r) => a + r.kTokens, 0)

const summary = {
  generatedAt: new Date().toISOString(),
  windowDays: +(((turns[turns.length - 1].ts - turns[0].ts) / 86400000)).toFixed(1),
  sessions: total,
  cleanSessions: cleanCount,
  successProxyPct: total ? +((cleanCount / total) * 100).toFixed(1) : null,
  interventionsTotal: totalInterventions,
  interventionsLinkedPct: interventions.length ? +((linkedInterventions / interventions.length) * 100).toFixed(1) : null,
  avgRoundsPerSession: total ? +(rows.reduce((a, r) => a + r.rounds, 0) / total).toFixed(1) : null,
  avgKTokensPerSession: total ? Math.round(aggTokens / total) : null,
  healthThresholds: { hitRatePct: HIT_HEALTHY * 100, breaksAB: BREAKS_OK, wasteK: WASTE_OK },
}

// ---- 输出 ----
if (AS_JSON) {
  console.log(JSON.stringify({ ok: true, summary, sessions: rows.slice(-LIMIT).reverse() }, null, 2))
  process.exit(0)
}

console.log('══ 任务级遥测（成功代理） ══')
console.log(`窗口 ${summary.windowDays} 天 | 会话 ${total} | 干净会话 ${cleanCount} (${summary.successProxyPct}%)`)
console.log(`干预: 总 ${totalInterventions} 次 | 快照 ${interventions.length} 条其中已关联纠正 ${linkedInterventions} 条 (${summary.interventionsLinkedPct}%)`)
console.log(`均轮次 ${summary.avgRoundsPerSession}/会话 | 均 ${summary.avgKTokensPerSession}K token/会话`)
console.log('')
console.log('近 %d 个会话:', Math.min(LIMIT, rows.length))
console.log('开始时间          分钟  轮次  Ktok  命中%  断裂AB  浪费K  干预  干净')
for (const r of rows.slice(-LIMIT).reverse()) {
  console.log(
    `${r.start}  ${String(r.minutes).padStart(4)}  ${String(r.rounds).padStart(4)}  ${String(r.kTokens).padStart(5)}  ` +
    `${String(r.hitRate ?? '-').padStart(5)}  ${String(r.breaksAB).padStart(6)}  ${String(r.wasteK).padStart(5)}  ` +
    `${String(r.interventions).padStart(4)}  ${r.clean ? '✓' : '✗'}`,
  )
}
console.log('')
console.log('成功代理口径: 干预=0 且 命中率≥90% 且 断裂AB≤3 且 浪费≤300K（VISION §4）')
