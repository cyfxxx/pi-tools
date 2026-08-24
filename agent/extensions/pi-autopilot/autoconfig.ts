import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { AutopilotConfig } from './types.ts'
import { CONFIG_FILE, defaultAutopilotConfig } from './types.ts'

const AGENT_DIR = getAgentDir()

export function configPath(): string {
  return join(AGENT_DIR, CONFIG_FILE)
}

export async function readAutopilotConfig(): Promise<AutopilotConfig> {
  const def = defaultAutopilotConfig()
  try {
    const raw = await readFile(configPath(), 'utf-8')
    const data = JSON.parse(raw) as Partial<AutopilotConfig>
    return {
      ...def,
      ...data,
      // 审计 MEDIUM：.pi-autopilot-config.json 为共享入库文件、可被手改——
      // 数值字段不校验时手改成字符串会让 decide() 内比较 NaN 恒 false、
      // failoverAfter/suspendAfter/maxFailovers 静默失效。按类型过滤，非法回退默认。
      enabled: typeof data.enabled === 'boolean' ? data.enabled : def.enabled,
      maxIdleMinutes: positiveNum(data.maxIdleMinutes, def.maxIdleMinutes),
      requeueOnRestart: typeof data.requeueOnRestart === 'boolean' ? data.requeueOnRestart : def.requeueOnRestart,
      fallbackModels: Array.isArray(data.fallbackModels) ? data.fallbackModels : def.fallbackModels,
      budget: {
        ...def.budget,
        ...numericFields(data.budget, ['maxRunsPerDay', 'maxCostPerDay']),
        allowedModels: Array.isArray(data.budget?.allowedModels) ? data.budget!.allowedModels : def.budget.allowedModels,
      },
      policy: {
        ...def.policy,
        ...numericFields(data.policy, ['failoverAfter', 'suspendAfter', 'timeoutFactor', 'maxFailovers']),
      },
    }
  } catch {
    return def
  }
}

function positiveNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

function numericFields<T>(src: T | undefined, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  if (!src) return out
  const source = src as Record<string, unknown>
  for (const k of keys) {
    const v = source[k as string]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v as T[keyof T]
  }
  return out
}

export async function writeAutopilotConfig(config: AutopilotConfig): Promise<void> {
  const p = configPath()
  // 审计 LOW：固定 .tmp 后缀在多实例并发写时互踩（A 覆盖 B 正在 rename 的 tmp，
  // 配置文件内容错乱）——tmp 带 pid 隔离各实例；rename 失败清理残留 tmp
  const tmp = `${p}.${process.pid}.tmp`
  await mkdir(dirname(p), { recursive: true })
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf-8')
  try {
    await rename(tmp, p)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 清理失败忽略（不吞原始错误） */ }
    throw e
  }
}
