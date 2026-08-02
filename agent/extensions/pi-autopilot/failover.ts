import type { FallbackModel } from './types.ts'
import { readTelemetry, statsByModel } from './telemetry.ts'
import { writeRestartRequest } from './state.ts'

export function currentModelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

// 选择 failover 目标：跳过当前模型，同 provider 优先，结合历史成功率排序
export async function selectFailover(
  chain: FallbackModel[],
  currentProvider: string,
  currentModel: string,
): Promise<FallbackModel | null> {
  if (!chain.length) return null
  const current = currentModelKey(currentProvider, currentModel)
  const candidates = chain.filter(f => currentModelKey(f.provider, f.model) !== current)
  if (!candidates.length) return null

  const telemetry = await readTelemetry()
  const byModel = new Map(statsByModel(telemetry).map(s => [currentModelKey(s.provider, s.model), s]))

  const scored = candidates.map(f => {
    const key = currentModelKey(f.provider, f.model)
    const stats = byModel.get(key)
    const sameProvider = f.provider === currentProvider ? 1 : 0
    // 无遥测时同 provider 优先；有遥测时成功率优先
    const score = stats
      ? stats.successRate * 100 + sameProvider * 10
      : 50 + sameProvider * 30
    return { f, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].f
}

export interface FailoverPlan {
  target: FallbackModel | null
  reason: string
}

export async function planFailover(
  chain: FallbackModel[],
  currentProvider: string,
  currentModel: string,
): Promise<FailoverPlan> {
  if (!chain.length) {
    return { target: null, reason: '未配置 fallbackModels' }
  }
  const target = await selectFailover(chain, currentProvider, currentModel)
  if (!target) {
    return { target: null, reason: 'fallbackModels 中无可用备选（全部为当前模型）' }
  }
  return {
    target,
    reason: `${currentProvider}/${currentModel} → ${target.provider}/${target.model}`,
  }
}

// 执行 failover：写重启请求（目标模型），wrapper 拉起后加载新模型
export async function executeFailover(
  target: FallbackModel,
  reason: string,
  dryRun: boolean,
): Promise<string> {
  if (dryRun) {
    return `[dry-run] 将执行: 切换模型 ${target.provider}/${target.model} 并重启\n原因: ${reason}`
  }
  writeRestartRequest('set_model', {
    targetProvider: target.provider,
    targetModel: target.model,
    reason: `failover: ${reason}`,
  })
  return `正在切换模型 ${target.provider}/${target.model} 并重启...`
}
