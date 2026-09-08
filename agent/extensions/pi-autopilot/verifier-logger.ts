/**
 * verifier-logger.ts — 验证器检测与记录
 *
 * 记录每次验证的详细数据，用于分析 Best-of-N 验证功能的效果：
 * - 成功率变化（启用/禁用验证对比）
 * - 边际收益递减点（N=2 vs N=3 vs N=5）
 * - 成本/质量权衡
 * - 验证器自身准确率
 *
 * 落盘格式：
 *   agent/stats/verifier.jsonl        — 每次验证详细记录
 *   agent/stats/verifier-summary.json — 聚合统计
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VerifierConfig } from './types.ts'

// ── 路径常量 ──────────────────────────────────────────────────────
const STATS_DIR = join(homedir(), '.pi', 'agent', 'stats')
const VERIFIER_LOG = join(STATS_DIR, 'verifier.jsonl')
const VERIFIER_SUMMARY = join(STATS_DIR, 'verifier-summary.json')
const MAX_LOG_DAYS = 30

// ── 核心记录类型 ──────────────────────────────────────────────────
export interface VerificationRecord {
  /** ISO 时间戳 */
  ts: string
  /** epoch ms */
  epoch: number
  /** 任务 ID */
  taskId: string
  /** 任务名称 */
  taskName: string
  /** 候选数量 */
  nCandidates: number
  /** 选中的候选索引（0-based） */
  selectedIndex: number
  /** 各候选分数（0-1） */
  scores: number[]
  /** 验证耗时 ms */
  durationMs: number
  /** 估算成本 $ */
  estCost: number
  /** 基线成本（单次执行估算） */
  baselineCost: number
  /** 成本倍数 */
  costMultiplier: number
  /** 是否通过（最优分 ≥ threshold） */
  passed: boolean
  /** 验证器判断理由 */
  reasoning: string
  /** 任务结果 */
  result: 'success' | 'failed'
  /** 验证器模型 */
  judgeModel: string
  /** ProgressTracker 分数序列（可选） */
  progressScores?: number[]
}

// ── 聚合统计类型 ──────────────────────────────────────────────────
export interface VerifierSummary {
  /** 统计截止时间 */
  lastUpdated: string
  /** 总验证次数 */
  totalVerifications: number
  /** 通过率 */
  passRate: number
  /** 平均成本倍数 */
  avgCostMultiplier: number
  /** 平均分数提升（相对单次执行） */
  avgScoreImprovement: number
  /** 按任务类型统计 */
  byTaskType: Record<string, { count: number; passRate: number; avgCost: number }>
  /** 边际收益分析：N 候选时的平均增益 */
  marginalGain: Array<{ n: number; count: number; avgGain: number }>
  /** 验证后成功率（vs 未验证基线） */
  successRateWithVerification: number
  successRateWithoutVerification: number
}

// ── 写入日志 ──────────────────────────────────────────────────────
function ensureDir(): void {
  if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true })
}

export function logVerification(record: VerificationRecord): void {
  try {
    ensureDir()
    appendFileSync(VERIFIER_LOG, JSON.stringify(record) + '\n')
  } catch {
    // 记录失败静默
  }
}

// ── 读取日志 ──────────────────────────────────────────────────────
function loadRecords(maxDays = MAX_LOG_DAYS): VerificationRecord[] {
  try {
    if (!existsSync(VERIFIER_LOG)) return []
    const cutoff = Date.now() - maxDays * 24 * 3600 * 1000
    return readFileSync(VERIFIER_LOG, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) as VerificationRecord } catch { return null } })
      .filter((r): r is VerificationRecord => r !== null && r.epoch >= cutoff)
  } catch {
    return []
  }
}

// ── 聚合统计 ──────────────────────────────────────────────────────
export function computeSummary(maxDays = 30): VerifierSummary {
  const records = loadRecords(maxDays)
  const now = new Date().toISOString()

  if (records.length === 0) {
    return {
      lastUpdated: now,
      totalVerifications: 0,
      passRate: 0,
      avgCostMultiplier: 0,
      avgScoreImprovement: 0,
      byTaskType: {},
      marginalGain: [],
      successRateWithVerification: 0,
      successRateWithoutVerification: 0,
    }
  }

  const passed = records.filter(r => r.passed)
  const successes = records.filter(r => r.result === 'success')
  const failures = records.filter(r => r.result === 'failed')

  // 按任务类型统计
  const byTaskType: VerifierSummary['byTaskType'] = {}
  for (const r of records) {
    const key = r.taskName || r.taskId
    if (!byTaskType[key]) byTaskType[key] = { count: 0, passRate: 0, avgCost: 0 }
    byTaskType[key].count++
  }
  for (const [key, stats] of Object.entries(byTaskType)) {
    const typeRecords = records.filter(r => (r.taskName || r.taskId) === key)
    stats.passRate = typeRecords.filter(r => r.passed).length / typeRecords.length
    stats.avgCost = typeRecords.reduce((s, r) => s + r.estCost, 0) / typeRecords.length
  }

  // 边际收益分析
  const marginalGainMap = new Map<number, { gains: number[] }>()
  for (const r of records) {
    if (r.scores.length < 2) continue
    const maxScore = Math.max(...r.scores)
    const firstScore = r.scores[0]
    const gain = maxScore - firstScore
    if (!marginalGainMap.has(r.nCandidates)) marginalGainMap.set(r.nCandidates, { gains: [] })
    marginalGainMap.get(r.nCandidates)!.gains.push(gain)
  }
  const marginalGain = [...marginalGainMap.entries()]
    .map(([n, { gains }]) => ({
      n,
      count: gains.length,
      avgGain: gains.reduce((s, g) => s + g, 0) / gains.length,
    }))
    .sort((a, b) => a.n - b.n)

  // 成功率对比
  const successRate = successes.length / records.length
  // 未验证基线：取第一个候选的结果（records 中 selectedIndex=0 的成功率）
  const firstCandidateResults = records.filter(r => r.selectedIndex === 0)
  const baselineRate = firstCandidateResults.length > 0
    ? firstCandidateResults.filter(r => r.result === 'success').length / firstCandidateResults.length
    : successRate

  return {
    lastUpdated: now,
    totalVerifications: records.length,
    passRate: passed.length / records.length,
    avgCostMultiplier: records.reduce((s, r) => s + r.costMultiplier, 0) / records.length,
    avgScoreImprovement: records.reduce((s, r) => {
      const maxScore = Math.max(...r.scores)
      const firstScore = r.scores[0] || 0
      return s + (maxScore - firstScore)
    }, 0) / records.length,
    byTaskType,
    marginalGain,
    successRateWithVerification: successRate,
    successRateWithoutVerification: baselineRate,
  }
}

// ── 保存/读取聚合统计 ─────────────────────────────────────────────
export function saveSummary(summary: VerifierSummary): void {
  try {
    ensureDir()
    const tmp = `${VERIFIER_SUMMARY}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(summary, null, 2), 'utf-8')
    renameSync(tmp, VERIFIER_SUMMARY)
  } catch {
    // 静默
  }
}

export function loadSummary(): VerifierSummary | null {
  try {
    if (!existsSync(VERIFIER_SUMMARY)) return null
    return JSON.parse(readFileSync(VERIFIER_SUMMARY, 'utf-8')) as VerifierSummary
  } catch {
    return null
  }
}

// ── 格式化报告（供 /verify report 使用） ──────────────────────────
export function formatReport(summary: VerifierSummary | null): string {
  if (!summary || summary.totalVerifications === 0) {
    return '验证统计：暂无数据'
  }

  const lines: string[] = [
    '─── LLM-as-a-Verifier 验证统计 ───',
    `总验证次数: ${summary.totalVerifications}`,
    `通过率: ${Math.round(summary.passRate * 100)}%`,
    `平均成本倍数: ${summary.avgCostMultiplier.toFixed(1)}x`,
    `平均分数提升: +${(summary.avgScoreImprovement * 100).toFixed(1)}%`,
    '',
    '成功率对比:',
    `  启用验证: ${Math.round(summary.successRateWithVerification * 100)}%`,
    `  未验证基线: ${Math.round(summary.successRateWithoutVerification * 100)}%`,
    `  提升: +${Math.round((summary.successRateWithVerification - summary.successRateWithoutVerification) * 100)}%`,
  ]

  if (summary.marginalGain.length > 0) {
    lines.push('', '边际收益（候选数 vs 平均增益）:')
    for (const mg of summary.marginalGain) {
      lines.push(`  N=${mg.n}: +${(mg.avgGain * 100).toFixed(1)}% (${mg.count} 次)`)
    }
  }

  const taskTypes = Object.entries(summary.byTaskType).sort((a, b) => b[1].count - a[1].count).slice(0, 5)
  if (taskTypes.length > 0) {
    lines.push('', '按任务类型（Top 5）:')
    for (const [name, stats] of taskTypes) {
      lines.push(`  ${name}: ${stats.count} 次, 通过率 ${Math.round(stats.passRate * 100)}%`)
    }
  }

  lines.push(`\n统计截止: ${summary.lastUpdated}`)
  return lines.join('\n')
}
