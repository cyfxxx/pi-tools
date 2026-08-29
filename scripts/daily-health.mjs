#!/usr/bin/env node
/**
 * 每日健康检查（VISION §4 度量承载，2026-08-29）
 *
 * 历史：旧 pi-scheduler 扩展曾有 daily-health-check 定时任务写 logs/daily-health.log，
 * pi-scheduler 退役融合后该环节丢失（2026-08-24 起停更），VISION 判据"命中率 ≥97%"
 * 失去每日度量产物。本脚本为硬层承载：确定性、零 LLM、只读数据源，仅追加日志。
 *
 * 口径与 usage-stats.mjs 对齐（保证数字可比）：
 *   - 数据源：agent/.usage-diag.jsonl 的轮记录（无 type 字段的行）
 *   - 窗口：过去 24h
 *   - 会话分段：间隔 >8min 或上下文回落 >60%
 *   - 断裂判定：cacheRead < prev-100 且 input > 10K；alert 只看 A/B 类（C=起步重建正常）
 *   - 命中率 = ΣcacheRead / Σ(input+cacheRead)，窗口内加权
 *   - alert 判据（对齐 task-metrics 成功代理口径）：会话 ≥3 且命中率 <90%，或 A/B 断裂 >3
 *   - 跨设备健康（2026-08-29 增）：设备最后遥测距今 >48h（memory/stats/tool-use-*.jsonl 尾行 ts）→ alert；
 *     种子-任务失配（agent/scheduled-seeds.json 声明但 scheduled-tasks.json 未注册，或 schedule 漂移）→ alert。
 *     注意对账机制“已存在不覆盖”：seeds 修改 schedule 后需各设备本地同步，漂移告警即为修复触发器
 *
 * 用法：
 *   node scripts/daily-health.mjs           # 计算并追加 logs/daily-health.log
 *   node scripts/daily-health.mjs --print   # 只输出不落盘（dry）
 */
import { readFileSync, statSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const DIAG = join(HOME, '.pi', 'agent', '.usage-diag.jsonl')
const ENTRIES = join(HOME, '.pi', 'memory', 'entries.json')
const LOG = join(HOME, '.pi', 'logs', 'daily-health.log')
const WINDOW_MS = 24 * 60 * 60 * 1000
const PRINT_ONLY = process.argv.includes('--print')

function loadRounds() {
  if (!existsSync(DIAG)) return []
  const out = []
  for (const l of readFileSync(DIAG, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try {
      const r = JSON.parse(l)
      if (r && r.type === undefined && typeof r.ts === 'number') out.push(r)
    } catch { /* 跳过损坏行 */ }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

function main() {
  const now = Date.now()
  const rounds = loadRounds().filter((r) => r.ts >= now - WINDOW_MS)

  // 会话分段 + 断裂判定（镜像 usage-stats.mjs，数字口径一致）
  const sessions = []
  let cur = null
  for (const r of rounds) {
    const isNew = !cur ||
      (r.ts - cur.lastTs) > 8 * 60 * 1000 ||
      (cur.lastCtx !== null && r.contextTokens < cur.lastCtx * 0.4)
    if (isNew) {
      cur = { lastTs: r.ts, lastCtx: r.contextTokens, rounds: 0, input: 0, cacheRead: 0, breaks: 0, abBreaks: 0, waste: 0, prevCacheRead: null }
      sessions.push(cur)
    }
    cur.lastTs = r.ts
    cur.lastCtx = r.contextTokens
    cur.rounds++
    cur.input += r.input || 0
    cur.cacheRead += r.cacheRead || 0
    if (cur.prevCacheRead !== null && (r.cacheRead || 0) < cur.prevCacheRead - 100 && (r.input || 0) > 10_000) {
      cur.breaks++
      if (cur.rounds > 5) {
        // A: cacheRead ≤ 10% contextTokens（全段重放）；否则 B（尾部重写）
        const cls = (r.cacheRead || 0) <= (r.contextTokens || 0) * 0.1 && (r.contextTokens || 0) > 0 ? 'A' : 'B'
        cur.abBreaks++
        cur.waste += (r.cacheRead || 0) < 1000 ? (r.input || 0) : (r.input || 0) + Math.max(0, cur.prevCacheRead - (r.cacheRead || 0))
        cur.lastCls = cls
      }
    }
    cur.prevCacheRead = r.cacheRead || 0
  }

  const totInput = sessions.reduce((a, s) => a + s.input, 0)
  const totCacheRead = sessions.reduce((a, s) => a + s.cacheRead, 0)
  const totBreaks = sessions.reduce((a, s) => a + s.breaks, 0)
  const totAB = sessions.reduce((a, s) => a + s.abBreaks, 0)
  const totWaste = sessions.reduce((a, s) => a + s.waste, 0)
  const hit = totInput + totCacheRead > 0 ? totCacheRead / (totInput + totCacheRead) : null

  let entryCount = 0
  let sizeMB = 0
  try {
    sizeMB = statSync(ENTRIES).size / 1024 / 1024
    const d = JSON.parse(readFileSync(ENTRIES, 'utf8'))
    entryCount = Array.isArray(d) ? d.length : (d.entries?.length ?? 0)
  } catch { /* 缺失时保持 0 */ }

  // 跨设备遥测健康：各设备最后遥测距今天数（memory/stats/tool-use-<device>.jsonl 尾行 ts）
  const reasons = []
  const STATS_DIR = join(HOME, '.pi', 'memory', 'stats')
  const devices = []
  let staleDevices = 0
  try {
    if (existsSync(STATS_DIR)) {
      for (const f of readdirSync(STATS_DIR)) {
        if (!f.startsWith('tool-use-') || !f.endsWith('.jsonl')) continue
        const dev = f.slice('tool-use-'.length, -'.jsonl'.length)
        const lines = readFileSync(join(STATS_DIR, f), 'utf8').split('\n').filter(Boolean)
        if (!lines.length) continue
        let last = 0
        try { last = JSON.parse(lines[lines.length - 1]).ts || 0 } catch { /* 跳过坏尾行 */ }
        const days = last ? (now - last) / 86400_000 : Infinity
        devices.push({ dev, days })
        if (days > 2) { staleDevices++; reasons.push(`设备 ${dev} 失联 ${days === Infinity ? '未知时长' : Math.floor(days) + '天'}`) }
      }
    }
  } catch { /* 统计缺失不阻塞主指标 */ }

  // 种子-任务失配：seeds 声明但本地未注册，或 schedule 漂移（对账“已存在不覆盖”需要人工/回顾同步）
  const SEEDS = join(HOME, '.pi', 'agent', 'scheduled-seeds.json')
  const TASKS = join(HOME, '.pi', 'agent', 'scheduled-tasks.json')
  let seedDrift = 0
  try {
    const seeds = JSON.parse(readFileSync(SEEDS, 'utf8')).tasks || []
    const local = {}
    try {
      const t = JSON.parse(readFileSync(TASKS, 'utf8')).tasks || []
      for (const x of t) local[x.name] = x
    } catch { /* 无本地任务文件视为全部未注册 */ }
    for (const s of seeds) {
      if (!local[s.name]) { seedDrift++; reasons.push(`种子任务 ${s.name} 未注册`) }
      else if (local[s.name].schedule && s.schedule && local[s.name].schedule !== s.schedule) { seedDrift++; reasons.push(`种子任务 ${s.name} schedule 漂移(${local[s.name].schedule}≠${s.schedule})`) }
    }
  } catch { /* seeds 缺失不阻塞 */ }

  // alert 判据：样本充足（≥3 会话）才判命中率；A/B 断裂独立判
  if (sessions.length >= 3 && hit !== null && hit < 0.9) reasons.push(`命中率 ${(hit * 100).toFixed(1)}%<90%`)
  if (totAB > 3) reasons.push(`A/B 断裂 ${totAB}>3`)
  const verdict = reasons.length ? 'alert' : 'ok'

  const ts = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())} ${p(ts.getHours())}:${p(ts.getMinutes())}`
  const hitStr = hit === null ? 'n/a(无数据)' : `${(hit * 100).toFixed(1)}%`
  const line = `${stamp} 命中=${hitStr} 断裂=${totBreaks}(AB=${totAB}) 浪费=${Math.round(totWaste / 1000)}K 存储=${sizeMB.toFixed(2)}MB 条目=${entryCount} 会话=${sessions.length} 轮=${rounds.length} 设备=${devices.length}(失联${staleDevices}) 种子失配=${seedDrift} 结论=${verdict}`

  console.log(line)
  if (verdict === 'alert') console.log('  └ 原因: ' + reasons.join('；'))
  if (!PRINT_ONLY) {
    appendFileSync(LOG, line + '\n')
    if (verdict === 'alert') appendFileSync(LOG, `  └ 原因: ${reasons.join('；')}\n`)
  }
}

main()
