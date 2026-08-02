import type { Task, ErrorClass, FallbackModel, AutopilotPolicy } from './types.ts'
import { errClassOf, estimateCost } from './telemetry.ts'
import { readSettings } from './config.ts'

export type PolicyAction =
  | { type: 'retry'; note: string }
  | { type: 'failover'; target: FallbackModel; note: string }
  | { type: 'suspend_task'; note: string }
  | { type: 'fail'; note: string }

export interface FailureInfo {
  stderr: string
  exitCode: number
  promptLen: number
  outputLen: number
  durationMs: number
}

export function classifyError(stderr: string, exitCode: number): ErrorClass {
  return errClassOf(stderr, exitCode)
}

export function decide(
  task: Task,
  errClass: ErrorClass,
  policy: AutopilotPolicy,
  fallbackModels: FallbackModel[],
  info: FailureInfo,
): PolicyAction {
  const failoverAfter = policy.failoverAfter ?? 2
  const suspendAfter = policy.suspendAfter ?? 5
  const timeoutFactor = policy.timeoutFactor ?? 2

  // 逻辑错误：换模型无意义，直接失败
  if (errClass === 'logic_error') {
    return { type: 'fail', note: `逻辑错误: ${info.stderr.slice(0, 200)}` }
  }

  if (errClass === 'timeout') {
    // 超时：若还有重试额度则重试；重试次数足够时考虑切更快模型
    if (task.failCount < (task.retries || 0)) {
      return { type: 'retry', note: `超时（${Math.round(info.durationMs / 1000)}s），按重试计划执行` }
    }
    if (fallbackModels.length > 0) {
      return { type: 'failover', target: fallbackModels[0], note: `超时且重试耗尽，切换模型尝试` }
    }
    return {
      type: 'fail',
      note: `超时（${Math.round(info.durationMs / 1000)}s），建议通过 /auto:policy 调整 maxRunTime 或配置 fallbackModels（超时因子 ${timeoutFactor}）`,
    }
  }

  // provider_down：优先 failover
  if (errClass === 'provider_down') {
    if (task.failCount >= failoverAfter) {
      if (fallbackModels.length > 0) {
        return { type: 'failover', target: fallbackModels[0], note: `连续 ${task.failCount} 次 provider 故障，切换模型` }
      }
      return { type: 'fail', note: 'provider 故障且未配置 fallbackModels，任务失败' }
    }
    if (task.failCount < (task.retries || 0)) {
      return { type: 'retry', note: `provider 故障第 ${task.failCount} 次，重试` }
    }
    return { type: 'fail', note: `provider 故障（第 ${task.failCount} 次），未达 failoverAfter 阈值` }
  }

  // 未知错误
  if (task.failCount >= suspendAfter) {
    return { type: 'suspend_task', note: `连续失败 ${task.failCount} 次（>= suspendAfter ${suspendAfter}），暂停任务` }
  }
  if (fallbackModels.length > 0 && task.failCount >= failoverAfter) {
    return { type: 'failover', target: fallbackModels[0], note: `连续失败 ${task.failCount} 次，切换模型` }
  }
  return { type: 'fail', note: `未知错误: ${info.stderr.slice(0, 200)}` }
}

export function currentModel(): { provider: string; model: string } {
  const s = readSettings()
  return { provider: s.defaultProvider || 'unknown', model: s.defaultModel || 'unknown' }
}

export { estimateCost }
