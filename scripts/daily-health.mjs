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
 *
 * 用法：
 *   node scripts/daily-health.mjs           # 计算并追加 logs/daily-health.log
 *   node scripts/daily-health.mjs --print   # 只输出不落盘（dry）
 */
import { readFileSync, statSync, existsSync, appendFileSync } from 'node:fs'
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

  // alert 判据：样本充足（≥3 会话）才判命中率；A/B 断裂独立判
  const reasons = []
  if (sessions.length >= 3 && hit !== null && hit < 0.9) reasons.push(`命中率 ${(hit * 100).toFixed(1)}%<90%`)
  if (totAB > 3) reasons.push(`A/B 断裂 ${totAB}>3`)
  const verdict = reasons.length ? 'alert' : 'ok'

  const ts = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())} ${p(ts.getHours())}:${p(ts.getMinutes())}`
  const hitStr = hit === null ? 'n/a(无数据)' : `${(hit * 100).toFixed(1)}%`
  const line = `${stamp} 命中=${hitStr} 断裂=${totBreaks}(AB=${totAB}) 浪费=${Math.round(totWaste / 1000)}K 存储=${sizeMB.toFixed(2)}MB 条目=${entryCount} 会话=${sessions.length} 轮=${rounds.length} 结论=${verdict}`

  console.log(line)
  if (verdict === 'alert') console.log('  └ 原因: ' + reasons.join('；'))
  if (!PRINT_ONLY) {
    appendFileSync(LOG, line + '\n')
    if (verdict === 'alert') appendFileSync(LOG, `  └ 原因: ${reasons.join('；')}\n`)
  }
}

main()
