import type { TelemetryEntry, AutopilotBudget } from './types.ts'
import { readTelemetry, todayRuns, todayCost } from './telemetry.ts'

export interface BudgetCheck {
  allowed: boolean
  reason: string
}

export async function checkBudget(budget: AutopilotBudget, model: string): Promise<BudgetCheck> {
  const runs = await readTelemetry()
  const runsToday = todayRuns(runs)
  const maxRuns = budget.maxRunsPerDay ?? 50
  if (runsToday >= maxRuns) {
    return { allowed: false, reason: `今日运行次数已达上限 (${runsToday}/${maxRuns})` }
  }
  const maxCost = budget.maxCostPerDay ?? 0
  if (maxCost > 0) {
    const costToday = todayCost(runs)
    if (costToday >= maxCost) {
      return { allowed: false, reason: `今日估算成本已达上限 ($${costToday.toFixed(4)}/$${maxCost})` }
    }
  }
  if (Array.isArray(budget.allowedModels) && budget.allowedModels.length > 0) {
    const allowed = budget.allowedModels.some(m => model === m || model.endsWith(`/${m}`))
    if (!allowed) {
      return { allowed: false, reason: `模型 ${model} 不在允许列表中` }
    }
  }
  return { allowed: true, reason: '' }
}

export function formatBudgetUsage(runs: TelemetryEntry[]): string {
  const today = new Date().toISOString().slice(0, 10)
  const todays = runs.filter(r => r.ts.slice(0, 10) === today)
  const cost = todays.reduce((s, r) => s + (r.estCost || 0), 0)
  return `今日: ${todays.length} 次运行, 估算成本 $${cost.toFixed(4)}`
}
