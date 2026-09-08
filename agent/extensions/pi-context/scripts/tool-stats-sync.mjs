#!/usr/bin/env node
/**
 * tool-stats-sync — 工具使用统计的每日聚合计数同步（2026-08-27 重构）
 *
 * 分工：采集在 pi 进程内（pi-context recordToolCall → memory/stats/tool-use-<device>.jsonl，
 * 每设备独立文件，append-only，原始事件**不入库**）；本脚本在独立进程做
 * 每日聚合与跨设备合并（git hook/post-pull、每日任务、手动），无需 TS 运行时。
 *
 * 同步模型（2026-08-27 起，替代"直接同步原始 jsonl"）：
 *   - 原始事件 tool-use-<device>.jsonl 仅存本机（gitignore），不再入库（臃肿）
 *   - --daily：聚合本机保留窗口事件 → 精简计数文件 memory/stats/tool-count-<device>.json
 *     （每工具使用次数 + 首末时间戳，几 KB），git 入库共享
 *   - 默认模式：合并各设备计数文件 + 本机日内增量事件 → agent/stats/tool-usage.json
 *     （本地聚合视图，gitignore）；post-merge hook 用此模式刷新
 *
 * 用法：
 *   node scripts/tool-stats-sync.mjs                 # 合并视图（读各设备 counts + 本机增量）
 *   node scripts/tool-stats-sync.mjs --daily         # 每日任务：聚合本机事件 → 计数文件入库
 *   node scripts/tool-stats-sync.mjs --prune         # 仅清理本机 30 天前原始事件
 *   node scripts/tool-stats-sync.mjs --report        # 仅输出聚合报告（不写文件）
 *   node scripts/tool-stats-sync.mjs --days 7        # 覆盖保留窗口（默认 30）
 *   node scripts/tool-stats-sync.mjs --daily --report# 生成计数并只报告
 *
 * 同步时机（git hooks，见 scripts/install-tool-sync-hooks.sh）：
 *   - post-merge（git pull 后自动触发）：合并各设备计数 + 本机增量 → tool-usage.json
 *   - 每日任务 tool-stats-daily（跨设备种子任务）：--daily 聚合本机 → 计数文件 push
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'

const args = process.argv.slice(2)
const ONLY_PRUNE = args.includes('--prune')
const ONLY_REPORT = args.includes('--report')
const DAILY = args.includes('--daily')
const DAYS_ARG = args.find((a) => a.startsWith('--days='))
const RETENTION_DAYS = DAYS_ARG ? parseInt(DAYS_ARG.split('=')[1], 10) : 30

const AGENT = join(homedir(), '.pi', 'agent')
const EVENTS_DIR = process.env.PI_TOOL_EVENTS_DIR || join(homedir(), '.pi', 'memory', 'stats')
const TOOL_USAGE = join(AGENT, 'stats', 'tool-usage.json')
const DEVICE = process.env.PI_DEVICE_ID || hostname() || 'host'
const DEVICE_FILE_TAG = DEVICE.replace(/[^A-Za-z0-9._-]/g, '_')
const COUNT_FILE = join(EVENTS_DIR, `tool-count-${DEVICE_FILE_TAG}.json`)
const DAY_MS = 24 * 60 * 60 * 1000

const fmtK = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const fmtDT = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 读取本机原始事件文件（保留窗口内），按 eid 去重 */
function loadLocalEvents() {
  const f = join(EVENTS_DIR, `tool-use-${DEVICE_FILE_TAG}.jsonl`)
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  const events = []
  const seen = new Set()
  if (!existsSync(f)) return events
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e || e.type !== 'tool-use' || e.ts < cutoff || seen.has(e.eid)) continue
    seen.add(e.eid)
    events.push(e)
  }
  return events.sort((a, b) => a.ts - b.ts)
}

/** 读取全部设备计数文件（成功入库的精简视图源） */
function loadCountFiles() {
  const counts = {}
  if (!existsSync(EVENTS_DIR)) return counts
  for (const name of readdirSync(EVENTS_DIR)) {
    if (!name.startsWith('tool-count-') || !name.endsWith('.json')) continue
    const device = name.slice('tool-count-'.length, -'.json'.length)
    try {
      const data = JSON.parse(readFileSync(join(EVENTS_DIR, name), 'utf8'))
      counts[device] = data
    } catch { /* 损坏计数文件忽略 */ }
  }
  return counts
}

/** 从事件聚合（含 device 分桶） */
function aggregate(events) {
  const acc = new Map()
  for (const e of events) {
    let cur = acc.get(e.tool)
    if (!cur) {
      cur = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: e.ts, lastTs: e.ts }
      acc.set(e.tool, cur)
    }
    cur.calls++
    cur.input += e.input ?? 0
    cur.cacheRead += e.cacheRead ?? 0
    cur.firstTs = Math.min(cur.firstTs, e.ts)
    cur.lastTs = Math.max(cur.lastTs, e.ts)
  }
  return acc
}

/** 合并各设备计数（已入库快照）→ 统一结构 { tool: {calls,input,cacheRead,firstTs,lastTs,byDevice} } */
function mergeCounts(countFiles) {
  const all = new Map()
  for (const [device, data] of Object.entries(countFiles)) {
    const tools = data?.tools || {}
    for (const [tool, v] of Object.entries(tools)) {
      let cur = all.get(tool)
      if (!cur) {
        cur = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: Infinity, lastTs: 0, byDevice: {} }
        all.set(tool, cur)
      }
      cur.calls += v.calls ?? 0
      cur.input += v.input ?? 0
      cur.cacheRead += v.cacheRead ?? 0
      cur.cacheWrite += v.cacheWrite ?? 0
      if (v.firstTs && v.firstTs < cur.firstTs) cur.firstTs = v.firstTs
      if (v.lastTs && v.lastTs > cur.lastTs) cur.lastTs = v.lastTs
      cur.byDevice[device] = {
        calls: v.calls ?? 0,
        input: v.input ?? 0,
        lastTs: v.lastTs ?? 0,
      }
    }
  }
  return all
}

/** 在合并视图上叠加本机保留窗口内、计数生成之后的新增事件（日内增量） */
function overlayLocalDelta(all, generatedAt) {
  const cutoffTs = generatedAt ? new Date(generatedAt).getTime() || 0 : 0
  const fresh = loadLocalEvents().filter((e) => e.ts > cutoffTs)
  for (const e of fresh) {
    let cur = all.get(e.tool)
    if (!cur) {
      cur = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: e.ts, lastTs: e.ts, byDevice: {} }
      all.set(e.tool, cur)
    }
    cur.calls++
    cur.input += e.input ?? 0
    cur.cacheRead += e.cacheRead ?? 0
    cur.firstTs = Math.min(cur.firstTs, e.ts)
    cur.lastTs = Math.max(cur.lastTs, e.ts)
    const d = cur.byDevice[DEVICE] ?? { calls: 0, input: 0, lastTs: 0 }
    d.calls++; d.input += e.input ?? 0; d.lastTs = Math.max(d.lastTs, e.ts)
    cur.byDevice[DEVICE] = d
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 清理本机事件文件中超过保留窗口的记录；返回删除条数（仅动本机文件） */
function pruneDevice() {
  const f = join(EVENTS_DIR, `tool-use-${DEVICE_FILE_TAG}.jsonl`)
  if (!existsSync(f)) return 0
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
  const isStale = (l) => { try { return JSON.parse(l).ts < cutoff } catch { return false } }
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const staleEids = new Set()
  for (const l of lines) {
    if (!isStale(l)) continue
    try { const e = JSON.parse(l); if (e.eid) staleEids.add(e.eid) } catch { /* 无法解析的行不剪 */ }
  }
  const removed = lines.filter(isStale).length
  if (removed > 0) {
    const seen = new Set()
    const merged = []
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue
      let e = null
      try { e = JSON.parse(l) } catch { merged.push(l); continue }
      if (e.eid) {
        if (staleEids.has(e.eid)) continue
        if (seen.has(e.eid)) continue
        seen.add(e.eid)
      }
      merged.push(l)
    }
    const tmp = f + '.tmp.' + process.pid
    writeFileSync(tmp, merged.join('\n') + (merged.length ? '\n' : ''), 'utf8')
    renameSync(tmp, f)
  }
  return removed
}

/** 生成/刷新本机计数文件（精简：每工具使用次数 + 首末时间；几 KB 入库） */
function writeDeviceCounts() {
  const events = loadLocalEvents()
  const agg = aggregate(events)
  const tools = {}
  let totalCalls = 0
  for (const [tool, v] of agg) {
    tools[tool] = { calls: v.calls, input: v.input, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite, firstTs: v.firstTs, lastTs: v.lastTs }
    totalCalls += v.calls
  }
  const count = {
    device: DEVICE,
    generatedAt: new Date().toISOString(),
    windowDays: RETENTION_DAYS,
    totalCalls,
    tools,
  }
  writeJson(COUNT_FILE, count)
  return count
}

function report(all, countFiles, freshEvents) {
  console.log(`\n工具使用统计（跨设备合并，${RETENTION_DAYS} 天窗口）\n`)
  const devices = []
  for (const [device, data] of Object.entries(countFiles)) {
    const tools = data?.tools || {}
    let calls = 0, firstTs = Infinity, lastTs = 0
    for (const v of Object.values(tools)) {
      calls += v.calls ?? 0
      if (v.firstTs && v.firstTs < firstTs) firstTs = v.firstTs
      if (v.lastTs && v.lastTs > lastTs) lastTs = v.lastTs
    }
    devices.push({ device, calls, firstTs, lastTs })
  }
  if (freshEvents.length) {
    const d = devices.find((x) => x.device === DEVICE) || { device: DEVICE, calls: 0, firstTs: Infinity, lastTs: 0 }
    d.calls += freshEvents.length
    d.lastTs = Math.max(d.lastTs, freshEvents[freshEvents.length - 1].ts)
    if (!devices.some((x) => x.device === DEVICE)) devices.push(d)
  }
  devices.sort((a, b) => b.calls - a.calls)
  console.log('设备         调用数   最早               最晚')
  for (const d of devices) {
    console.log(`${d.device.padEnd(13)} ${String(d.calls).padStart(6)}   ${fmtDT(d.firstTs)}   ${fmtDT(d.lastTs)}`)
  }

  console.log('\n工具            调用数   first    last')
  const rows = [...all.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 20)
  for (const [tool, v] of rows) {
    console.log(`${tool.padEnd(16)} ${String(v.calls).padStart(5)}   ${fmtDT(v.firstTs).slice(5)}   ${fmtDT(v.lastTs).slice(5)}`)
  }
  console.log(`\n聚合已写: ${TOOL_USAGE}`)
}

// ── 主流程 ──
if (ONLY_PRUNE) {
  const n = pruneDevice()
  console.log(`已清理本机(${DEVICE}) ${RETENTION_DAYS} 天前事件 ${n} 条`)
  process.exit(0)
}

let pruned = 0
let freshEvents = []
const countFiles = loadCountFiles()
if (DAILY) {
  // 每日任务入口：先清理过期事件，再生成本机计数文件（入库）
  pruned = pruneDevice()
  const count = writeDeviceCounts()
  if (!ONLY_REPORT) console.log(`已生成本机计数(${DEVICE}) ${count.totalCalls} 次调用 → ${COUNT_FILE.replace(homedir(), '~')}`)
}
const all = mergeCounts(countFiles)
if (!DAILY) {
  // 合并视图：counts 生成之后的本机新事件为日内增量（其他设备仅见其计数快照）
  const mine = countFiles[DEVICE]
  const cutoffTs = mine?.generatedAt ? new Date(mine.generatedAt).getTime() || 0 : 0
  freshEvents = loadLocalEvents().filter((e) => e.ts > cutoffTs)
  overlayLocalDelta(all, mine?.generatedAt)
}

if (!ONLY_REPORT) {
  writeJson(TOOL_USAGE, Object.fromEntries(all))
  if (pruned > 0) console.log(`已清理本机(${DEVICE}) ${RETENTION_DAYS} 天前事件 ${pruned} 条`)
}
report(all, countFiles, freshEvents)