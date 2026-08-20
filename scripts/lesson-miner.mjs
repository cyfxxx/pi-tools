#!/usr/bin/env node
/**
 * lesson-miner — 失败会话学习矿工（2.4 阶段，2026-08-20）
 *
 * 目的：只读扫描 usage-diag 与 tool-events，识别失败/健康异常会话与断裂轮，
 *       输出可操作的『候选教训线索』到 stdout，供 LLM 会话据此提炼 lessons 存入
 *       pi-memory。脚本本身不写 memory、不改任何配置/注入面（纯只读分析，缓存纪律）。
 *
 * 数据源：
 *   - ~/.pi/agent/.usage-diag.jsonl（pi-context 每轮 turn_end 记录；PI_AGENT_DIR 覆盖基线目录）
 *   - ~/.pi/agent/stats/tool-events.jsonl（tool-enable 事件台账；缺失时跳过归因）
 *   - usage-diag 内的 auto-compact / prune 事件行（断裂时刻 ±2min 窗口关联）
 *
 * 会话分段（与 usage-stats.mjs 同思路，独立实现，不改动它）：
 *   - 时间间隔 >8min → 新会话（停顿）
 *   - contextTokens 较上轮回落 >60% → 会话重建
 * 断裂判定：cacheRead 较上轮突降 >100 且 input 暴增 >10K → 断裂轮
 * 断裂三分类：
 *   [A] 全段重放  cacheRead≈0（≤ contextTokens 的 10%）→ 前缀整体失效。归因线索：
 *       compaction/早期消息改写（thinking 剪枝等 post-hoc 修改）/ 工具 schema 变化
 *       （附近 tool-enable 事件）/ provider 缓存键变化（模型切换/failover）/ 大工具输出改写。
 *   [B] 尾部重写  cacheRead 有值但突降 → 前缀命中、尾段重建。归因线索：
 *       注入块字节变化（pi-memory 注入 / 压力档位切换）、keepRecentTokens 保留块重建。
 *   [C] 起步重建  断裂在会话前 5 轮内 → 正常开销，不报、不计入异常判定与汇总。
 *
 * 异常会话判定（C 类断裂不计入）：
 *   - 命中率 <90%（cacheRead/(input+cacheRead)），或
 *   - 断裂(A+B) >3，或 浪费(A+B) >300K
 *   退化数据（input+cacheRead=0 的轮）不参与判定。
 *
 * 用法：
 *   node scripts/lesson-miner.mjs                     # 输出异常会话时间线（默认最多 25 个，按严重度排序）
 *   node scripts/lesson-miner.mjs --limit 0           # 展开全部异常会话
 *   node scripts/lesson-miner.mjs --limit 10          # 只看最严重的 10 个
 *   node scripts/lesson-miner.mjs --out report.txt    # 报告同时写入文件（唯一允许的副作用）
 *   PI_AGENT_DIR=/path node scripts/lesson-miner.mjs  # 覆盖数据基线目录（默认 ~/.pi/agent）
 *
 * 幂等：默认纯只读，重复运行无副作用（--out 除外）。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---- 常量与参数 ----
const BASE = process.env.PI_AGENT_DIR || join(homedir(), '.pi', 'agent')
const DIAG = join(BASE, '.usage-diag.jsonl')
const TOOL_EVENTS = join(BASE, 'stats', 'tool-events.jsonl')
const EVENT_WINDOW_MS = 120_000   // 断裂轮前后 ±2min 内的事件视为可能归因
const ANOMALY_HIT = 0.90          // 命中率健康线（低于视为异常）
const ANOMALY_BREAKS = 3          // 断裂次数阈值（A+B，超过视为异常）
const ANOMALY_WASTE = 300_000     // 浪费 token 阈值（A+B，超过视为异常）

const args = process.argv.slice(2)
function usage() {
  console.log(`用法: node scripts/lesson-miner.mjs [--limit N] [--out PATH]
  --limit N   展开异常会话数量上限（默认 25；0 = 全部展开）
  --out PATH  报告同时写入 PATH（唯一可选副作用；默认仅 stdout）
  环境变量 PI_AGENT_DIR 覆盖数据基线目录（默认 ~/.pi/agent）
  数据缺失时输出『暂无数据』并退出码 0（优雅降级）`)
}
if (args.includes('-h') || args.includes('--help')) { usage(); process.exit(0) }
let LIMIT = 25
const li = args.indexOf('--limit')
if (li >= 0 && args[li + 1]) {
  const n = parseInt(args[li + 1], 10)
  LIMIT = Number.isFinite(n) && n >= 0 ? n : 25
}
let OUT = null
const oi = args.indexOf('--out')
if (oi >= 0 && args[oi + 1]) OUT = args[oi + 1]

// ---- 数据加载（优雅降级：文件缺失 → 『暂无数据』退出码 0）----
if (!existsSync(DIAG)) {
  console.log('暂无数据')
  console.error(`（usage-diag 不存在: ${DIAG}；可设 PI_AGENT_DIR 覆盖基线目录）`)
  process.exit(0)
}
const diag = readFileSync(DIAG, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)
// 只取带 input/cacheRead 的用量轮（过滤 auto-compact/prune 等事件行）
const turns = diag.filter(r => Number.isFinite(r.input) && Number.isFinite(r.cacheRead))
if (turns.length === 0) {
  console.log('暂无数据')
  console.error(`（${DIAG} 无用量轮记录）`)
  process.exit(0)
}
// 工具启用事件台账（缺失则跳过归因，不报错）
const toolEvents = existsSync(TOOL_EVENTS)
  ? readFileSync(TOOL_EVENTS, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(e => e && e.type === 'tool-enable')
  : []
// usage-diag 内的事件行（压缩 / 分层擦除），供断裂轮 ±2min 归因
const compactEvents = diag.filter(l => l.type === 'auto-compact')
const pruneEvents = diag.filter(l => l.type === 'prune')

// ---- 会话分段（>8min 停顿 / contextTokens 回落 >60% 重建）----
const sessions = []
let cur = null
for (const r of turns) {
  const ts = r.ts
  const ctx = r.contextTokens
  const isNew = !cur ||
    (ts - cur.lastTs) > 8 * 60 * 1000 ||            // 停顿 >8min → 新会话
    (cur.lastCtx !== null && ctx < cur.lastCtx * 0.4) // 上下文回落 >60% → 会话重建
  if (isNew) {
    cur = {
      startTs: ts, lastTs: ts, lastCtx: ctx,
      rounds: 0, input: 0, cacheRead: 0,
      ctxStart: ctx, ctxEnd: ctx, prevCacheRead: null,
      breaks: [], waste: 0,
    }
    sessions.push(cur)
  }
  cur.lastTs = ts
  cur.lastCtx = ctx
  cur.rounds++
  cur.input += r.input
  cur.cacheRead += r.cacheRead
  cur.ctxEnd = ctx
  // 断裂判定：cacheRead 较上轮突降 >100 且 input 暴增（≈重发大量旧内容）
  if (cur.prevCacheRead !== null && r.cacheRead < cur.prevCacheRead - 100 && r.input > 10_000) {
    const waste = r.input + Math.max(0, cur.prevCacheRead - r.cacheRead)
    // 三分类（与 usage-stats 同口径）：C 起步重建 / A 全段重放 / B 尾部重写
    const cls = cur.rounds <= 5 ? 'C'
      : (r.cacheRead <= (r.contextTokens * 0.1) && r.contextTokens > 0 ? 'A' : 'B')
    cur.breaks.push({ i: cur.rounds, cls, ts, prevCacheRead: cur.prevCacheRead, cacheRead: r.cacheRead, input: r.input, ctx: r.contextTokens, waste })
    cur.waste += waste
  }
  cur.prevCacheRead = r.cacheRead
}

// ---- 异常会话标记（C 类起步断裂不计入）----
const flagged = []
for (const s of sessions) {
  const denom = s.input + s.cacheRead
  if (denom <= 0) continue // 退化数据：无实际用量，不判定
  s.hitRate = s.cacheRead / denom
  s.breaksNonC = s.breaks.filter(b => b.cls !== 'C').length
  s.wasteNonC = s.breaks.filter(b => b.cls !== 'C').reduce((t, b) => t + b.waste, 0)
  s.breaksC = s.breaks.length - s.breaksNonC
  if (s.hitRate < ANOMALY_HIT || s.breaksNonC > ANOMALY_BREAKS || s.wasteNonC > ANOMALY_WASTE) {
    flagged.push(s)
  }
}
// 按严重度排序：浪费多 → 断裂多 → 命中率低
flagged.sort((a, b) => b.wasteNonC - a.wasteNonC || b.breaksNonC - a.breaksNonC || a.hitRate - b.hitRate)

// ---- 输出 ----
if (flagged.length === 0) {
  console.log('无异常会话')
  process.exit(0)
}
const fmtDate = (ts) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ')
const fmtMin = (ts) => new Date(ts).toISOString().slice(11, 16)
const fmtK = (n) => `${Math.round(n / 1000)}K`
const fmt = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const countCls = (list, cls) => list.reduce((t, s) => t + s.breaks.filter(b => b.cls === cls).length, 0)

/** 断裂轮归因线索：±2min 内 tool-enable / auto-compact / prune 事件 + 分类建议排查对象 */
function clueLines(b, te, ce, pe) {
  const out = []
  out.push(b.cls === 'A'
    ? '    归因线索: A 类全段重放（cacheRead≈0 → 前缀整体失效）'
    : '    归因线索: B 类尾部重写（cacheRead 有值但突降 → 前缀命中、尾段重建）')
  const ev = []
  if (te.length) ev.push(`tool-enable×${te.length}（${te.map(e => `${e.group}@${fmtMin(e.ts)}`).join('、')}）`)
  if (ce.length) ev.push(`auto-compact×${ce.length}（@${ce.map(e => fmtMin(e.ts)).join('、')} 阈 ${fmtK(ce[0].threshold)}）`)
  if (pe.length) ev.push(`prune×${pe.length}（回收 ${fmtK(pe.reduce((t, e) => t + e.prunedTokens, 0))} token）`)
  out.push(ev.length
    ? `    ⚑ 附近±2min: ${ev.join(' · ')}`
    : '    ○ 附近±2min 无 tool-enable/auto-compact/prune 事件')
  if (b.cls === 'A') {
    // 嫌疑按事件匹配度排序：有 tool-enable → 工具 schema 变化；有压缩/擦除 → 早期改写
    const suspects = []
    if (te.length) suspects.push('工具 schema 变化（enable_tool 新增注册工具 → system prompt 变）')
    if (ce.length || pe.length) suspects.push('压缩/分层擦除改写早期消息（thinking 剪枝等 post-hoc 修改）')
    suspects.push('provider 缓存键变化（模型切换/failover）', '大工具输出改写')
    out.push(`    → 建议排查: ${suspects.join(' / ')}；对照 agent/sessions/ 会话文件与 stats/tool-fingerprint.jsonl；注入块位于消息尾部（≤500 token）非大浪费来源`)
  } else {
    out.push('    → 建议排查: 压力档位切换（<75% 不注入 / ≥75% / ≥90% 固定文案）/ pi-memory 注入块字节变化 / keepRecentTokens 保留块重建；运行 agent/extensions/tests/cache-guard.mjs 校验注入面基线')
  }
  return out
}

const show = LIMIT === 0 ? flagged : flagged.slice(0, LIMIT)
const out = []
out.push('=== 失败会话学习矿工（lesson-miner）===')
out.push(`数据源: ${DIAG} · ${sessions.length} 个会话 / ${turns.length} 个用量轮` +
  (toolEvents.length ? ` / tool-enable×${toolEvents.length}` : '') +
  (compactEvents.length ? ` / auto-compact×${compactEvents.length}` : '') +
  (pruneEvents.length ? ` / prune×${pruneEvents.length}` : ''))
out.push('异常判定: 命中率<90% 或 断裂(A+B)>3 或 浪费(A+B)>300K；C 类起步断裂不报。时间 UTC。')
out.push('')
for (let i = 0; i < show.length; i++) {
  const s = show[i]
  const rate = (s.hitRate * 100).toFixed(1)
  out.push(`[${i + 1}/${flagged.length}] ${fmtDate(s.startTs)} → ${fmtDate(s.lastTs)} · ${s.rounds} 轮 · 命中 ${rate}%${s.hitRate < ANOMALY_HIT ? ' ⚠' : ''} · 断裂 ${s.breaksNonC}${s.breaksC ? `（另有 C 起步 ${s.breaksC} 不计）` : ''} · 浪费 ${fmt(s.wasteNonC)} · ctx ${fmt(s.ctxStart)}→${fmt(s.ctxEnd)}`)
  const abs = s.breaks.filter(b => b.cls !== 'C')
  if (abs.length === 0) {
    out.push(`  ○ 无断裂轮：命中率偏低为整体现象${s.rounds === 1 ? '（单轮会话，信息量有限）' : ''}；查 provider 缓存键 / 每轮注入量`)
    continue
  }
  for (const b of abs) {
    out.push(`  └ [${b.cls}] 轮#${b.i} @${fmtMin(b.ts)} 断前前缀 ${fmtK(b.prevCacheRead)}→命中 ${fmtK(b.cacheRead)} 重发 ${fmtK(b.input)} 浪费 ${fmtK(b.waste)}`)
    const te = toolEvents.filter(e => Math.abs(e.ts - b.ts) < EVENT_WINDOW_MS)
    const ce = compactEvents.filter(e => Math.abs(e.ts - b.ts) < EVENT_WINDOW_MS)
    const pe = pruneEvents.filter(e => Math.abs(e.ts - b.ts) < EVENT_WINDOW_MS)
    out.push(...clueLines(b, te, ce, pe))
  }
  out.push('')
}
// 结尾汇总一行
out.push(`汇总: ${flagged.length} 个异常会话 · ${flagged.reduce((t, s) => t + s.breaksNonC, 0)} 个断裂点（A×${countCls(flagged, 'A')} B×${countCls(flagged, 'B')}；C×${countCls(flagged, 'C')} 起步不计）· 浪费合计 ${fmt(flagged.reduce((t, s) => t + s.wasteNonC, 0))}`)
if (LIMIT !== 0 && flagged.length > LIMIT) {
  out.push(`（另有 ${flagged.length - LIMIT} 个异常会话未展开：按严重度取前 ${LIMIT}，加 --limit 0 查看全部）`)
}
const text = out.join('\n')
console.log(text)
if (OUT) {
  try { writeFileSync(OUT, text + '\n') } catch (e) { console.error(`--out 写入失败: ${e.message}`) }
}
