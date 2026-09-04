/**
 * shadow-review.ts — 影子审查（Anthropic Shadow Mode 的 Pi 实现）
 *
 * 核心原则：静默运行、只记录不拦截，对比人工审查结果持续迭代规则。
 * 初期只记录 warning，待准确率达标后可升级为 hook-registry 的 block action。
 *
 * 使用方式：
 *   import { shadowReview } from '../lib/shadow-review.ts'
 *   const findings = shadowReview.checkToolCall('bash', { command: 'rm -rf /tmp/test' })
 *   if (findings.length > 0) console.warn(findings)
 *
 * 数据落盘：agent/stats/shadow-review.jsonl（按天轮转，30 天保留）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Severity = 'info' | 'warning' | 'critical'

export interface ShadowFinding {
  type: string
  severity: Severity
  tool: string
  message: string
  /** 触发的规则 ID */
  ruleId: string
  /** 匹配到的内容摘要 */
  match?: string
}

interface ShadowRule {
  id: string
  tool: string
  severity: Severity
  test: (input: Record<string, unknown>) => ShadowFinding | null
}

const SHADOW_DIR = join(homedir(), '.pi', 'agent', 'stats')
const SHADOW_FILE = join(SHADOW_DIR, 'shadow-review.jsonl')
const MAX_DAYS = 30

function recordFinding(f: ShadowFinding): void {
  try {
    mkdirSync(SHADOW_DIR, { recursive: true })
    const record = { ...f, ts: Date.now(), iso: new Date().toISOString() }
    appendFileSync(SHADOW_FILE, JSON.stringify(record) + '\n')
  } catch {
    // 记录失败静默
  }
}

// ── 规则集 ──

const rules: ShadowRule[] = [
  // bash 危险命令
  {
    id: 'bash-dangerous-cmd',
    tool: 'bash',
    severity: 'warning',
    test: (input) => {
      const cmd = (input.command as string) ?? ''
      if (/\brm\s+-[rRf]/.test(cmd)) return { type: 'dangerous-command', severity: 'warning', tool: 'bash', ruleId: 'bash-dangerous-cmd', message: 'rm -rf 命令', match: cmd.slice(0, 100) }
      if (/\bsudo\b/.test(cmd)) return { type: 'dangerous-command', severity: 'critical', tool: 'bash', ruleId: 'bash-dangerous-cmd', message: 'sudo 命令', match: cmd.slice(0, 100) }
      if (/\bchmod\s+777\b/.test(cmd)) return { type: 'dangerous-command', severity: 'warning', tool: 'bash', ruleId: 'bash-dangerous-cmd', message: 'chmod 777 命令', match: cmd.slice(0, 100) }
      return null
    },
  },
  // bash 外部网络请求
  {
    id: 'bash-network',
    tool: 'bash',
    severity: 'info',
    test: (input) => {
      const cmd = (input.command as string) ?? ''
      if (/\bcurl\b|\bwget\b/.test(cmd) && /\bhttps?:\/\//.test(cmd)) {
        const urlMatch = cmd.match(/https?:\/\/[^\s"']+/)
        return { type: 'network-request', severity: 'info', tool: 'bash', ruleId: 'bash-network', message: '外部网络请求', match: urlMatch?.[0]?.slice(0, 100) }
      }
      return null
    },
  },
  // write/edit 敏感文件
  {
    id: 'sensitive-file-write',
    tool: '*',
    severity: 'warning',
    test: (input) => {
      const target = (input.file_path ?? input.path ?? '') as string
      if (/auth\.json|settings\.json|models\.json|\.env|private[_-]?key/i.test(target)) {
        return { type: 'sensitive-file', severity: 'warning', tool: '*', ruleId: 'sensitive-file-write', message: '敏感文件写入', match: target }
      }
      return null
    },
  },
  // write 超大内容（可能误操作）
  {
    id: 'large-write',
    tool: 'write',
    severity: 'info',
    test: (input) => {
      const content = (input.content as string) ?? ''
      if (content.length > 100_000) {
        return { type: 'large-content', severity: 'info', tool: 'write', ruleId: 'large-write', message: `写入内容较大（${Math.round(content.length / 1024)}KB）`, match: `${content.length} chars` }
      }
      return null
    },
  },
]

/**
 * 检查一次工具调用，返回发现列表（可能为空）。
 * 纯确定性规则，零 LLM 成本。
 */
export function checkToolCall(toolName: string, input: Record<string, unknown>): ShadowFinding[] {
  const findings: ShadowFinding[] = []
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== toolName) continue
    try {
      const finding = rule.test(input)
      if (finding) {
        findings.push(finding)
        recordFinding(finding)
      }
    } catch {
      // 规则执行失败不阻塞
    }
  }
  return findings
}

/**
 * 读取最近 N 天的 shadow review 发现（供报告生成）。
 */
export function loadShadowFindings(maxDays = MAX_DAYS): ShadowFinding[] {
  try {
    if (!existsSync(SHADOW_FILE)) return []
    const cutoff = Date.now() - maxDays * 24 * 3600 * 1000
    return readFileSync(SHADOW_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter((r): r is ShadowFinding & { ts: number } => r !== null && r.ts >= cutoff)
  } catch {
    return []
  }
}

/**
 * 汇总报告：按 ruleId 聚合发现数量。
 */
export function shadowReviewReport(maxDays = 7): Record<string, { count: number; severity: string }> {
  const findings = loadShadowFindings(maxDays)
  const agg: Record<string, { count: number; severity: string }> = {}
  for (const f of findings) {
    if (!agg[f.ruleId]) agg[f.ruleId] = { count: 0, severity: f.severity }
    agg[f.ruleId].count++
  }
  return agg
}
