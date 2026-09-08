/**
 * verifier.ts — LLM-as-a-Verifier 核心验证逻辑
 *
 * 借鉴 LLM-as-a-Verifier 框架思想，用 pi 原生 Node.js 实现：
 * - Best-of-N：同一任务生成 N 个候选方案
 * - LLM-as-judge：让模型对候选打分（不需要 logprobs）
 * - ProgressTracker：逐步骤实时评分
 *
 * 设计原则：
 * - Fail-open：验证器出错时回退到单次执行
 * - 成本感知：验证成本 ≤ 配置上限
 * - 无外部 Python 依赖
 */

import type { VerifierConfig } from './types.ts'
import { logVerification, type VerificationRecord } from './verifier-logger.ts'

// ── 评分结果 ──────────────────────────────────────────────────────
export interface CandidateScore {
  /** 候选索引（0-based） */
  index: number
  /** 评分（0-1） */
  score: number
  /** 评分理由 */
  reasoning: string
}

export interface VerificationResult {
  /** 选中的最优候选索引 */
  bestIndex: number
  /** 所有候选评分 */
  scores: CandidateScore[]
  /** 是否通过（最优分 ≥ threshold） */
  passed: boolean
  /** 验证器判断理由摘要 */
  reasoning: string
  /** 验证耗时 ms */
  durationMs: number
  /** 估算成本 $ */
  estCost: number
}

// ── 默认评分提示词 ────────────────────────────────────────────────
const DEFAULT_JUDGE_PROMPT = `你是一个任务执行方案的评审专家。请对以下 N 个候选方案进行评分，选出最优方案。

评分维度（各维度 0-1 分）：
1. **正确性**：方案是否正确解决了问题
2. **完整性**：方案是否覆盖了所有要求
3. **效率**：方案是否高效，无冗余步骤
4. **安全性**：方案是否安全，无风险操作

请为每个候选方案给出：
- 综合分数（0-1，加权平均）
- 简短理由（1-2 句话）

最后选出最优方案（最高分的候选）。`

// ── 生成候选方案 ──────────────────────────────────────────────────
async function generateCandidate(
  prompt: string,
  modelInfo: { provider: string; model: string },
  signal?: AbortSignal,
): Promise<{ content: string; durationMs: number }> {
  const start = Date.now()
  try {
    // 通过 pi 的 LLM 接口生成（由 scheduler 传入）
    // 这里返回占位，实际调用由 scheduler.ts 集成时注入
    return {
      content: `[Candidate for: ${prompt.slice(0, 50)}...]`,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    if (signal?.aborted) throw new Error('验证被取消')
    throw err
  }
}

// ── LLM-as-Judge 评分 ─────────────────────────────────────────────
async function judgeCandidates(
  prompt: string,
  candidates: string[],
  config: VerifierConfig,
  signal?: AbortSignal,
): Promise<{ scores: CandidateScore[]; reasoning: string }> {
  const judgePrompt = config.judgePrompt || DEFAULT_JUDGE_PROMPT

  const candidateTexts = candidates
    .map((c, i) => `--- 候选 ${i + 1} ---\n${c}`)
    .join('\n\n')

  const fullPrompt = `${judgePrompt}

## 任务描述
${prompt}

## 候选方案
${candidateTexts}

请为每个候选方案评分（0-1），并选出最优方案。
格式：
候选1: 分数=X.XX, 理由=...
候选2: 分数=X.XX, 理由=...
最优: 候选N`

  // 实际 LLM 调用由集成层注入
  // 解析评分结果
  const scores: CandidateScore[] = candidates.map((_, i) => ({
    index: i,
    score: 0.5 + Math.random() * 0.3, // 占位：实际由 LLM 返回
    reasoning: `候选 ${i + 1} 的评分理由`,
  }))

  const best = scores.reduce((a, b) => a.score > b.score ? a : b)

  return {
    scores,
    reasoning: `最优候选: ${best.index + 1} (分数: ${best.score.toFixed(2)})`,
  }
}

// ── ProgressTracker ───────────────────────────────────────────────
export interface ProgressStep {
  /** 步骤名称 */
  toolName: string
  /** 步骤结果摘要 */
  resultSummary: string
  /** 评分（0-1） */
  score: number
  /** 时间戳 */
  ts: number
}

export class ProgressTracker {
  private steps: ProgressStep[] = []
  private readonly threshold: number

  constructor(threshold = 0.2) {
    this.threshold = threshold
  }

  /** 记录一步并返回当前进度分数（0-1） */
  step(toolName: string, resultSummary: string): number {
    // 简单启发式评分：基于工具类型和结果内容
    let score = 0.5

    // 成功指标
    if (/success|完成|已创建|已更新/i.test(resultSummary)) score += 0.2
    if (/error|失败|错误|异常/i.test(resultSummary)) score -= 0.3
    if (/timeout|超时/i.test(resultSummary)) score -= 0.2

    // 工具类型权重
    if (['bash', 'write', 'edit'].includes(toolName)) {
      // 写操作风险较高
      if (/rm|delete|remove/i.test(resultSummary)) score -= 0.1
    }

    score = Math.max(0, Math.min(1, score))

    this.steps.push({
      toolName,
      resultSummary: resultSummary.slice(0, 200),
      score,
      ts: Date.now(),
    })

    return this.currentScore()
  }

  /** 当前累计进度分数 */
  currentScore(): number {
    if (this.steps.length === 0) return 0.5
    const scores = this.steps.map(s => s.score)
    // 加权平均：越新的步骤权重越大
    let totalWeight = 0
    let weightedSum = 0
    for (let i = 0; i < scores.length; i++) {
      const weight = i + 1 // 线性递增权重
      weightedSum += scores[i] * weight
      totalWeight += weight
    }
    return totalWeight > 0 ? weightedSum / totalWeight : 0.5
  }

  /** 是否应该提前终止 */
  shouldAbort(): boolean {
    return this.currentScore() < this.threshold
  }

  /** 获取所有步骤 */
  getSteps(): ProgressStep[] {
    return [...this.steps]
  }

  /** 获取分数序列（用于记录） */
  getScoreSequence(): number[] {
    return this.steps.map(s => s.score)
  }

  /** 重置 */
  reset(): void {
    this.steps = []
  }
}

// ── Best-of-N 验证主流程 ──────────────────────────────────────────
export interface BestOfNOptions {
  /** 候选数量 */
  nCandidates?: number
  /** 通过阈值 */
  threshold?: number
  /** 验证器模型（可选，不传用当前模型） */
  judgeModel?: string
  /** 超时 ms */
  timeout?: number
  /** 取消信号 */
  signal?: AbortSignal
}

/**
 * Best-of-N 验证：生成 N 个候选方案，用 LLM 评分选出最优。
 *
 * @param generateFn  生成候选的函数（由调用方提供，接入 pi 的 LLM）
 * @param prompt      任务提示词
 * @param config      验证配置
 * @param options     可选参数
 * @returns           验证结果
 */
export async function bestOfN(
  generateFn: (prompt: string) => Promise<string>,
  prompt: string,
  config: VerifierConfig,
  options: BestOfNOptions = {},
): Promise<VerificationResult> {
  const n = options.nCandidates ?? config.nCandidates
  const threshold = options.threshold ?? config.threshold
  const timeout = options.timeout ?? 30_000
  const startTime = Date.now()

  // fail-open：验证器出错时的回退结果
  const fallback = (): VerificationResult => ({
    bestIndex: 0,
    scores: [{ index: 0, score: 0.5, reasoning: '验证器失败，回退到第一个候选' }],
    passed: true,
    reasoning: '验证器出错，fail-open 回退',
    durationMs: Date.now() - startTime,
    estCost: 0,
  })

  try {
    // 1. 并行生成 N 个候选
    const candidatePromises = Array.from({ length: n }, async (_, i) => {
      try {
        return await Promise.race([
          generateFn(prompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`候选 ${i} 生成超时`)), timeout)
          ),
        ])
      } catch (err) {
        return `[候选 ${i} 生成失败: ${(err as Error).message}]`
      }
    })

    const candidates = await Promise.all(candidatePromises)

    // 2. LLM-as-judge 评分
    const { scores, reasoning } = await judgeCandidates(
      prompt,
      candidates,
      config,
      options.signal,
    )

    // 3. 选出最优
    const best = scores.reduce((a, b) => a.score > b.score ? a : b)

    // 4. 检查成本
    const estCost = 0 // 实际成本由集成层计算
    if (estCost > config.maxCostPerVerify) {
      return {
        ...fallback(),
        reasoning: `验证成本 $${estCost.toFixed(4)} 超过上限 $${config.maxCostPerVerify}，回退`,
      }
    }

    return {
      bestIndex: best.index,
      scores,
      passed: best.score >= threshold,
      reasoning,
      durationMs: Date.now() - startTime,
      estCost,
    }
  } catch (err) {
    console.error('[pi-verifier] 验证失败，fail-open:', (err as Error).message)
    return fallback()
  }
}

// ── 记录验证结果 ──────────────────────────────────────────────────
export function recordVerification(
  result: VerificationResult,
  taskId: string,
  taskName: string,
  config: VerifierConfig,
  baselineCost: number,
  judgeModel: string,
  resultOutcome: 'success' | 'failed',
): void {
  if (config.logLevel === 'none') return

  const record: VerificationRecord = {
    ts: new Date().toISOString(),
    epoch: Date.now(),
    taskId,
    taskName,
    nCandidates: result.scores.length,
    selectedIndex: result.bestIndex,
    scores: result.scores.map(s => s.score),
    durationMs: result.durationMs,
    estCost: result.estCost,
    baselineCost,
    costMultiplier: baselineCost > 0 ? result.estCost / baselineCost : 0,
    passed: result.passed,
    reasoning: result.reasoning,
    result: resultOutcome,
    judgeModel,
  }

  logVerification(record)
}
