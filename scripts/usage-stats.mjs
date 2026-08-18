#!/usr/bin/env node
/**
 * usage-stats — 跨会话缓存/用量聚合统计（2026-08-18）
 *
 * 数据源：~/.pi/agent/.usage-diag.jsonl（pi-context 每轮 turn_end 记录）
 * 输出：agent/stats/usage-sessions.jsonl（按会话聚合，startTs 幂等去重）
 *
 * 会话分段规则：
 *   - 时间间隔 > 8min 视为新会话（停顿）
 *   - contextTokens 较上轮回落 > 60% 视为会话重建（重启/恢复/压缩）
 * 每会话指标：轮数 / input 总量 / cacheRead 总量 / 加权命中率 /
 *   断裂次数（cacheRead 较上轮突降 >100 且 input 暴增）/ 断裂零命中浪费 /
 *   起始与结束上下文 / 起止时间
 *
 * 用法：
 *   node scripts/usage-stats.mjs            # 聚合并输出最近 10 会话对比（幂等）
 *   node scripts/usage-stats.mjs --all      # 输出全部历史会话
 *   node scripts/usage-stats.mjs --json     # 只输出当前会话 JSON（供自动化）
 *
 * 与 99% 目标的差距诊断：命中率 < 90% 或断裂 > 3 次 → 用 cache-guard + usage-diag
 * 逐轮定位（断裂轮 cacheRead ≈ 断裂点位置；对照该轮事件找根因，2026-08-18 实战：
 * thinking 剪枝 16K 预算每 2-3 轮改早期消息 → 27 次断裂/3.8h，64K 预算后休眠）。
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const AGENT = join(homedir(), '.pi', 'agent')
const DIAG = join(AGENT, '.usage-diag.jsonl')
const STATS_DIR = join(AGENT, 'stats')
const OUTPUT = join(STATS_DIR, 'usage-sessions.jsonl')

const args = process.argv.slice(2)
const SHOW_ALL = args.includes('--all')
const JSON_ONLY = args.includes('--json')

if (!existsSync(DIAG)) {
  console.error(`usage-diag 不存在: ${DIAG}`)
  process.exit(1)
}

const lines = readFileSync(DIAG, 'utf8').trim().split('\n').map(l => {
  try { return JSON.parse(l) } catch { return null }
}).filter(Boolean)

// 只取带 input/cacheRead 的用量轮（过滤 auto-compact/prune 等事件行）
const turns = lines.filter(r => Number.isFinite(r.input) && Number.isFinite(r.cacheRead))

// ---- 会话分段 ----
const sessions = []
let cur = null
for (const r of turns) {
  const ts = r.ts, ctx = r.contextTokens
  const isNewSession = !cur ||
    (ts - cur.lastTs) > 8 * 60 * 1000 ||                       // 停顿 >8min
    (cur.lastCtx !== null && ctx < cur.lastCtx * 0.4)          // 上下文回落 >60%（会话重建）
  if (isNewSession) {
    cur = {
      startTs: ts, lastTs: ts, lastCtx: ctx,
      rounds: 0, input: 0, cacheRead: 0, breaks: 0, breakWaste: 0,
      ctxStart: ctx, ctxEnd: ctx, prevCacheRead: null,
    }
    sessions.push(cur)
  }
  cur.lastTs = ts
  cur.lastCtx = ctx
  cur.rounds++
  cur.input += r.input
  cur.cacheRead += r.cacheRead
  cur.ctxEnd = ctx
  // 断裂判定：cacheRead 较上轮突降且 input 暴增（≈重发大量旧内容）
  if (cur.prevCacheRead !== null && r.cacheRead < cur.prevCacheRead - 100 && r.input > 10_000) {
    cur.breaks++
    cur.breakWaste += r.input + Math.max(0, cur.prevCacheRead - r.cacheRead)
  }
  cur.prevCacheRead = r.cacheRead
}

// ---- 幂等合并（按 startTs 去重，替换已有同名会话行）----
mkdirSync(STATS_DIR, { recursive: true })
const existing = new Map()
if (existsSync(OUTPUT)) {
  for (const l of readFileSync(OUTPUT, 'utf8').trim().split('\n').filter(Boolean)) {
    try { const o = JSON.parse(l); existing.set(o.startTs, o) } catch { /* 损坏行忽略 */ }
  }
}
let appended = 0
for (const s of sessions) {
  const key = s.startTs
  const prev = existing.get(key)
  const same = prev && prev.rounds === s.rounds && prev.input === s.input
  existing.set(key, {
    ...s,
    hitRate: s.cacheRead / (s.input + s.cacheRead),
    breakWaste: s.breakWaste,
    updatedAt: new Date().toISOString(),
  })
  if (!same) appended++
}
if (appended > 0) {
  writeFileSync(OUTPUT, [...existing.values()]
    .sort((a, b) => a.startTs - b.startTs)
    .map(o => JSON.stringify(o)).join('\n') + '\n')
}

// ---- 输出 ----
const all = [...existing.values()].sort((a, b) => a.startTs - b.startTs)
if (JSON_ONLY) {
  console.log(JSON.stringify(all[all.length - 1], null, 2))
  process.exit(0)
}
const list = SHOW_ALL ? all : all.slice(-10)
const fmtDate = (ts) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ')
const fmtMin = (ts) => new Date(ts).toISOString().slice(11, 16)
console.log(`\n跨会话用量统计（${all.length} 个会话，数据源 ${DIAG}）\n`)
console.log('UTC日期时间     | 轮数 | input总计    | 命中率  | 断裂 | 浪费tokens | ctx起→止')
for (const s of list) {
  const rate = (s.hitRate * 100).toFixed(1)
  const flag = rate < 90 ? ' ⚠' : (rate >= 97 ? ' ✓' : '')
  console.log(
    `${fmtDate(s.startTs)} ${fmtMin(s.startTs)} | ${String(s.rounds).padStart(4)} | ${String(s.input).padStart(11)} | ${String(rate).padStart(5)}%${flag} | ${String(s.breaks).padStart(4)} | ${String(s.breakWaste).padStart(10)} | ${s.ctxStart}→${s.ctxEnd}`
  )
}
// 当前会话 vs 目标
const curS = all[all.length - 1]
const target = 0.97
const gap = curS.hitRate - target
console.log(`\n当前会话: 命中 ${(curS.hitRate * 100).toFixed(1)}%（目标 ${(target * 100).toFixed(0)}%）差距 ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp | 断裂 ${curS.breaks} 次, 浪费 ${curS.breakWaste} tokens`)
if (curS.hitRate < 0.90 || curS.breaks > 3) {
  console.log('  ⚠ 低于健康线 — 定位流程：')
  console.log('    1) node scripts/usage-stats.mjs --json 看当前会话细分')
  console.log('    2) 找断裂轮（usage-diag 中 cacheRead 突降 + input 暴增）→ 断裂点 ≈ cacheRead')
  console.log('    3) 对照该轮事件（大工具输出/注入变化/消息修改机制）；运行 node agent/extensions/tests/cache-guard.mjs 查注入面')
  console.log('    4) 2026-08-18 已知根因参考：thinking 剪枝/擦除等 post-hoc 修改历史 → 已调阈值（64K/120K/80K）')
}