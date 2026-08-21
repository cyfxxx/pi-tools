#!/usr/bin/env node
/**
 * usage-stats — 跨会话缓存/用量聚合统计（2026-08-18，断裂画像增强 2026-08-19）
 *
 * 数据源：~/.pi/agent/.usage-diag.jsonl（pi-context 每轮 turn_end 记录）
 * 输出：agent/stats/usage-sessions.jsonl（按会话聚合，startTs 幂等去重；含断裂明细跨会话保留）
 *
 * 会话分段规则：
 *   - 时间间隔 > 8min 视为新会话（停顿）
 *   - contextTokens 较上轮回落 > 60% 视为会话重建（重启/恢复/压缩）
 * 每会话指标：轮数 / input 总量 / cacheRead 总量 / 加权命中率 /
 *   断裂次数（cacheRead 较上轮突降 >100 且 input 暴增）/ 断裂零命中浪费 /
 *   断裂明细（breakList：轮序/类别/前后上下文/compacted）/ 起始与结束上下文 / 起止时间
 *
 * 断裂类别判读（2026-08-19 加入）：
 *   [A] 全段重放  cacheRead≈0 且 input≈前轮上下文 → 前缀整体失效。挂钩：
 *       工具 schema 运行时变化（enable_tool 启用休眠组会新增注册工具，system prompt 变）、
 *       compaction/裁剪改写早期消息、provider 侧缓存键变化（模型切换/failover）。
 *   [B] 尾部重写  cacheRead 有值但较上轮突降输入暴增 → 前缀命中、尾段重建。挂钩：
 *       注入块字节变化（pi-memory 注入/压力档位切换）、keepRecentTokens 保留块重建。
 *   [C] 起步重建  断裂发生在会话前 5 轮内 → 上下文初始化，正常开销，不计入修复目标。
 *
 * 诊断指引（对照 stats/tool-fingerprint.jsonl 与 agent/sessions/ 会话文件）：
 *   A 类 → 全重放（cacheRead≈0）。2026-08-20 实证（agent-session.js:902 + 会话文件查验）：
 *           pi-memory 注入块位于消息序列尾部（紧贴对应 user 消息之后，buildInjectionBlock
 *           确定性重建，无写入时恒定），其变化只重发注入块自身（≤500 token），不可能造成
 *           数百 K 浪费。大浪费应优先查：compaction 改写 / 早期消息改写（thinking 剪枝等
 *           post-hoc 修改）/ provider 缓存键变化 / 大工具输出改写 / steering/follow-up 注入。
 *   B 类 → 查 pi-memory/inject.ts 注入块与上下文压力档位（cache-guard 已锁定其注入面基线）。
 *   C 类 → 无需处理。
 *
 * 用法：
 *   node scripts/usage-stats.mjs            # 聚合并输出最近 10 会话对比（幂等）
 *   node scripts/usage-stats.mjs --all      # 输出全部历史会话
 *   node scripts/usage-stats.mjs --json     # 只输出当前会话 JSON（供自动化）
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const AGENT = join(homedir(), '.pi', 'agent')
const DIAG = join(AGENT, '.usage-diag.jsonl')
const STATS_DIR = join(AGENT, 'stats')
const OUTPUT = join(STATS_DIR, 'usage-sessions.jsonl')

// 工具启用事件台账（2026-08-19：enable_tool 唯一能改运行时工具集，事件供 A 类断裂归因）
const TOOL_EVENTS = join(AGENT, 'stats', 'tool-events.jsonl')
// 工具用量账单（2026-08-20 2.5 阶段：pi-context tool_result hook 按工具累加）
const TOOL_USAGE = join(AGENT, 'stats', 'tool-usage.json')
const toolEvents = existsSync(TOOL_EVENTS)
  ? readFileSync(TOOL_EVENTS, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(e => e && e.type === 'tool-enable')
  : []
const TOOL_EVENT_WINDOW_MS = 120_000 // 断裂轮前后 2 分钟内的启用事件视为可能归因

const args = process.argv.slice(2)
const SHOW_ALL = args.includes('--all')
const JSON_ONLY = args.includes('--json')
const TOOLS = args.includes('--tools')
const THINKING = args.includes('--thinking')
const LEVELS = args.includes('--levels')

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
      breakList: [],
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
    const waste = r.input + Math.max(0, cur.prevCacheRead - r.cacheRead)
    cur.breakWaste += waste
    // 断裂分类（A 全段重放 / B 尾部重写 / C 起步重建）——持久化供跨会话归因
    const prevCacheK = cur.prevCacheRead >= 1000 ? Math.round(cur.prevCacheRead / 1000) : cur.prevCacheRead
    const cls = cur.rounds <= 5 ? 'C'
      : (r.cacheRead <= (r.contextTokens * 0.1) && r.contextTokens > 0 ? 'A' : 'B')
    cur.breakList.push({
      i: cur.rounds,
      cls,
      ts,
      prevCacheK,               // 断前命中前缀长度（疑似丢失起点）
      cacheReadK: Math.round(r.cacheRead / 1000),
      inputK: Math.round(r.input / 1000),
      ctxK: Math.round(r.contextTokens / 1000),
      wasteK: Math.round(waste / 1000),
      compacted: !!r.compacted,
    })
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
  // 断裂明细（2026-08-19：命中 <90% 或有断裂时展示分类，供跨会话归因）
  if ((s.breakList && s.breakList.length) && (rate < 90 || SHOW_ALL)) {
    for (const b of s.breakList) {
      console.log(`      └ [${b.cls}] 轮#${b.i} @${fmtMin(b.ts)} 断前前缀${b.prevCacheK}K→命中${b.cacheReadK}K 重发${b.inputK}K 浪费${b.wasteK}K${b.compacted ? ' (compacted)' : ''}`)
      // A 类归因：关联工具启用事件台账（±2 分钟窗口）
      if (b.cls === 'A') {
        const nearby = toolEvents.filter(e => Math.abs(e.ts - b.ts) < TOOL_EVENT_WINDOW_MS)
        if (nearby.length) {
          for (const e of nearby) console.log(`            ⚑ 归因: ${e.group} 组启用（via ${e.via}）@${fmtMin(e.ts)} → 工具 schema 变化致前缀全断`)
        } else {
          console.log(`            ○ 该轮无工具启用事件 → 注入块(≤500 token,尾部)不是大浪费来源；优先查 compaction 改写/早期消息改写/大工具输出改写/provider 缓存键（用法见 usage-diag 会话细分）`)
        }
      }
    }
  }
}
// 当前会话 vs 目标
if (all.length === 0) {
  console.log("\n尚无用量会话（.usage-diag.jsonl 无数据或为空）。")
  process.exit(0)
}
const curS = all[all.length - 1]
const target = 0.97
const gap = curS.hitRate - target
console.log(`\n当前会话: 命中 ${(curS.hitRate * 100).toFixed(1)}%（目标 ${(target * 100).toFixed(0)}%）差距 ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp | 断裂 ${curS.breaks} 次, 浪费 ${curS.breakWaste} tokens`)
// 断裂分类汇总（2026-08-19）：A 全段重放 / B 尾部重写 / C 起步
if (curS.breakList && curS.breakList.length) {
  const agg = curS.breakList.reduce((m, b) => { m[b.cls] = (m[b.cls] || 0) + 1; return m }, {})
  const hint = Object.entries(agg).map(([c, n]) => `${c}×${n}`).join(' ')
  console.log(`  断裂分类: ${hint}${agg.A ? ' — A 类查：compaction 改写/早期消息改写（thinking 剪枝等）/大工具输出改写/provider 缓存键（注入块仅尾部≤500 token 非主因）' : ''}${agg.B ? ' — B 类查：压力档位切换/keepRecentTokens 重建/注入块尾部变化' : ''}${agg.C ? ' — C 类为会话起步重建，正常' : ''}`)
}
if (curS.hitRate < 0.90 || curS.breaks > 3) {
  console.log('  ⚠ 低于健康线 — 定位流程：')
  console.log('    1) node scripts/usage-stats.mjs --json 看当前会话细分')
  console.log('    2) 找断裂轮（usage-diag 中 cacheRead 突降 + input 暴增）→ 断裂点 ≈ cacheRead')
  console.log('    3) 对照该轮事件（大工具输出/注入变化/消息修改机制）；运行 node agent/extensions/tests/cache-guard.mjs 查注入面')
  console.log('    4) A 类断裂先查 compaction/早期消息改写（对照 usage-diag 该轮前后 cacheRead 细分）；pi-memory 注入在尾部（≤500 token）非主因，勿再归因记忆操作')
  console.log('    5) 2026-08-18 已知根因参考：thinking 剪枝/擦除等 post-hoc 修改历史 → 已调阈值（64K/120K/80K）')
}
// 工具用量账单（--tools，2026-08-20 2.5 阶段）
if (TOOLS) {
  console.log('\n工具用量账单（累计，数据源 stats/tool-usage.json，--tools）\n')
  console.log('工具名           调用数   input总计    cacheRead    命中率   cacheWrite')
  try {
    const tu = existsSync(TOOL_USAGE) ? JSON.parse(readFileSync(TOOL_USAGE, 'utf8')) : {}
    const rows = Object.entries(tu)
      .map(([name, v]) => ({ name, ...v, ratio: (v.input + v.cacheRead) > 0 ? v.cacheRead / (v.input + v.cacheRead) : 0 }))
      .sort((a, b) => b.input - a.input)
    for (const r of rows.slice(0, 20)) {
      console.log(
        `${r.name.padEnd(18)} ${String(r.calls).padStart(5)}  ${String(Math.round(r.input / 1000) + 'K').padStart(9)}  ${String(Math.round(r.cacheRead / 1000) + 'K').padStart(9)}  ${(r.ratio * 100).toFixed(1) + '%'.padStart(5)}  ${String(Math.round(r.cacheWrite / 1000) + 'K').padStart(9)}`,
      )
    }
    if (rows.length === 0) console.log('  （暂无数据：运行过工具调用后落账）')
    const callTotal = rows.reduce((s, r) => s + r.calls, 0)
    const inputTotal = rows.reduce((s, r) => s + r.input, 0)
    console.log(`\n合计: ${rows.length} 个工具, ${callTotal} 次调用, input ${Math.round(inputTotal / 1000)}K（按 input 降序 top20）`)
  } catch (e) {
    console.log('  （账单读取失败: ' + e.message + '）')
  }
}

// 思考量按会话聚合（--thinking，2026-08-21 task #14：量化档位变化）
if (THINKING) {
  const meters = lines.filter(l => l && l.type === 'thinking-meter')
  console.log('\n思考量按会话聚合（thinking-meter；需重启 pi 后由 pi-context 记账积累）\n')
  if (meters.length === 0) {
    console.log('  暂无数据：等待 pi-context thinking-meter 记账（重启后每轮记录）')
  } else {
    console.log('会话起时        | 轮数 | thinking总量  | 每轮均值')
    const segs = []; let cur = []
    meters.sort((a, b) => a.ts - b.ts)
    for (const m of meters) {
      const last = cur[cur.length - 1]
      if (last && m.ts - last.ts > 8 * 60 * 1000) { segs.push(cur); cur = [] }
      cur.push(m)
    }
    if (cur.length) segs.push(cur)
    for (const seg of segs.slice(-10)) {
      const total = seg.reduce((s, x) => s + x.tokens, 0)
      const mean = total / seg.length
      const t = new Date(seg[0].ts).toISOString().slice(5, 16).replace('T', ' ')
      console.log(`${t}  ${String(seg.length).padStart(4)}  ${String(Math.round(total / 1000) + 'K').padStart(10)}  ${String(Math.round(mean / 1000) + 'K').padStart(9)}`)
    }
  }
}

// thinking 档位切换记录（--levels，2026-08-21 task #25：每次切换强制落 ledger）
if (LEVELS) {
  const evs = lines.filter((l) => l && l.type === 'level-change')
  console.log('\nthinking 档位切换记录（level-change；自动切档启用后由 pi-context 记账）\n')
  if (evs.length === 0) {
    console.log('  暂无切换记录（自动切档 task #25 启用后积累；切换后思考量看 --thinking）')
  } else {
    evs.sort((a, b) => a.ts - b.ts)
    console.log('时间            | 来源   | 从 → 到     | 压力      | 原因')
    for (const e of evs) {
      const t = new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ')
      console.log(`${t}  | ${String(e.source || 'auto').padEnd(6)} | ${String(e.from).padEnd(4)} → ${String(e.to).padEnd(4)}   | ${String(e.pressure).padEnd(9)} | ${e.reason}`)
    }
  }
}
