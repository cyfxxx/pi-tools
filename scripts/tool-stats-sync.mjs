#!/usr/bin/env node
/**
 * tool-stats-sync — 工具使用统计的跨设备合并/30 天清理/聚合重算（2026-08-24）
 *
 * 分工：采集在 pi 进程内（pi-context recordToolCall → memory/stats/tool-use-<device>.jsonl，
 * 每设备独立文件，append-only）；本脚本在独立进程（git hook/pre-push/pull 后、手动）做
 * 离线合并与重算，无需 TS 运行时。
 *
 * 用法：
 *   node scripts/tool-stats-sync.mjs                 # 默认：聚合(30天) + 清理本机 + 报告
 *   node scripts/tool-stats-sync.mjs --prune         # 仅清理本机 30 天前事件
 *   node scripts/tool-stats-sync.mjs --report        # 仅输出聚合报告
 *   node scripts/tool-stats-sync.mjs --days 7        # 覆盖保留窗口（默认 30）
 *
 * 同步时机（git hooks，见 scripts/install-tool-sync-hooks.sh）：
 *   - post-merge（git pull 后自动触发）：聚合全部设备事件 + 清理本机 → tool-usage.json
 *   - push 侧无需 hook：pi-backup sync 的 git add -A 自动带上本机新增事件文件
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'

const args = process.argv.slice(2)
const ONLY_PRUNE = args.includes('--prune')
const ONLY_REPORT = args.includes('--report')
const DAYS_ARG = args.find((a) => a.startsWith('--days='))
const RETENTION_DAYS = DAYS_ARG ? parseInt(DAYS_ARG.split('=')[1], 10) : 30

const AGENT = join(homedir(), '.pi', 'agent')
const EVENTS_DIR = process.env.PI_TOOL_EVENTS_DIR || join(homedir(), '.pi', 'memory', 'stats')
const TOOL_USAGE = join(AGENT, 'stats', 'tool-usage.json')
const DEVICE = process.env.PI_DEVICE_ID || hostname() || 'host'
const DEVICE_FILE_TAG = DEVICE.replace(/[^A-Za-z0-9._-]/g, '_')
const DAY_MS = 24 * 60 * 60 * 1000

const fmtK = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const fmtDT = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 读取全部设备事件文件，过滤保留窗口，按 ts 升序 + eid 去重（防 pull 竞态重复） */
function loadEvents() {
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  const byDevice = {}
  const seen = new Set()
  if (!existsSync(EVENTS_DIR)) return { events: [], byDevice: {} }
  for (const name of readdirSync(EVENTS_DIR)) {
    if (!name.startsWith('tool-use-') || !name.endsWith('.jsonl')) continue
    const device = name.slice('tool-use-'.length, -'.jsonl'.length)
    let dec = byDevice[device]
    if (!dec) { dec = { events: [], count: 0, firstTs: Infinity, lastTs: 0 }; byDevice[device] = dec }
    for (const line of readFileSync(join(EVENTS_DIR, name), 'utf8').split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || e.type !== 'tool-use' || e.ts < cutoff || seen.has(e.eid)) continue
      seen.add(e.eid)
      dec.events.push(e); dec.count++
      if (e.ts < dec.firstTs) dec.firstTs = e.ts
      if (e.ts > dec.lastTs) dec.lastTs = e.ts
    }
  }
  const flat = Object.values(byDevice).flatMap((d) => d.events).sort((a, b) => a.ts - b.ts)
  return { events: flat, byDevice }
}

/** 从事件聚合（含 device 分桶 + 首末时间）并写 tool-usage.json */
function recompute(events, byDevice) {
  const acc = new Map()
  for (const e of events) {
    let cur = acc.get(e.tool)
    if (!cur) {
      cur = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: e.ts, lastTs: e.ts, byDevice: {} }
      acc.set(e.tool, cur)
    }
    cur.calls++
    cur.input += e.input ?? 0
    cur.cacheRead += e.cacheRead ?? 0
    cur.firstTs = Math.min(cur.firstTs, e.ts)
    cur.lastTs = Math.max(cur.lastTs, e.ts)
    const d = cur.byDevice[e.device] ?? { calls: 0, input: 0, lastTs: e.ts }
    d.calls++; d.input += e.input ?? 0; d.lastTs = Math.max(d.lastTs, e.ts)
    cur.byDevice[e.device] = d
  }
  const all = Object.fromEntries(acc)
  mkdirSync(dirname(TOOL_USAGE), { recursive: true })
  const tmp = TOOL_USAGE + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
  renameSync(tmp, TOOL_USAGE)
  return all
}

/** 清理本机事件文件中超过保留窗口的记录；返回删除条数（仅动本机文件，避免误删他人） */
function pruneDevice(device, tag) {
  const f = join(EVENTS_DIR, `tool-use-${tag}.jsonl`)
  if (!existsSync(f)) return 0
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const kept = lines.filter((l) => {
    try { return JSON.parse(l).ts >= cutoff } catch { return true }
  })
  const removed = lines.length - kept.length
  if (removed > 0) {
    const tmp = f + '.tmp.' + process.pid
    writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
    renameSync(tmp, f)
  }
  return removed
}

function report(all, byDevice) {
  console.log(`\n工具使用统计（跨设备合并，${RETENTION_DAYS} 天窗口；事件目录 memory/stats/）\n`)
  console.log('设备         事件数   最早               最晚')
  const devices = Object.entries(byDevice).sort((a, b) => b[1].count - a[1].count)
  let totalEvents = 0
  for (const [dev, d] of devices) {
    totalEvents += d.count
    console.log(`${dev.padEnd(13)} ${String(d.count).padStart(6)}   ${fmtDT(d.firstTs)}   ${fmtDT(d.lastTs)}`)
  }
  console.log(`\n设备总数 ${devices.length}，事件总数 ${totalEvents}，去重后有效 ${totalEvents}`)

  console.log('\n工具            调用数   first    last')
  const rows = Object.entries(all).sort((a, b) => b[1].calls - a[1].calls).slice(0, 20)
  for (const [tool, v] of rows) {
    console.log(`${tool.padEnd(16)} ${String(v.calls).padStart(5)}   ${fmtDT(v.firstTs).slice(5)}   ${fmtDT(v.lastTs).slice(5)}`)
  }
  if (rows.length === 0) console.log('  （暂无事件：运行过工具调用并达成 agent_settled 后落账）')
  console.log(`\n聚合已写: ${TOOL_USAGE}`)
}

// ── 主流程 ──
if (ONLY_PRUNE) {
  const n = pruneDevice(DEVICE, DEVICE_FILE_TAG)
  console.log(`已清理本机(${DEVICE}) ${RETENTION_DAYS} 天前事件 ${n} 条`)
  process.exit(0)
}

const { events, byDevice } = loadEvents()
const pruned = pruneDevice(DEVICE, DEVICE_FILE_TAG)
const all = recompute(events, byDevice)

if (ONLY_REPORT) report(all, byDevice)
else {
  if (pruned > 0) console.log(`已清理本机(${DEVICE}) ${RETENTION_DAYS} 天前事件 ${pruned} 条`)
  report(all, byDevice)
}
