/**
 * hook-registry.ts — 确定性流程拦截钩子（Anthropic Hook 模式的 Pi 实现）
 *
 * 核心原则：Hook 是确定性规则驱动的强制拦截，不依赖 LLM 判断。
 * 与 Skill（AI 自觉遵守，概率性）互补：Hook = 刚性兜底，Skill = 柔性引导。
 *
 * 使用方式：
 *   import { hookRegistry } from '../lib/hook-registry.ts'
 *   // 注册：拦截危险 bash 命令
 *   hookRegistry.register('block-dangerous-bash', {
 *     phase: 'before_tool_call',
 *     tool: 'bash',
 *     test: (input) => /rm\s+-rf|sudo|chmod\s+777/.test(input.command ?? ''),
 *     action: 'block',
 *     message: '危险命令被拦截：rm -rf/sudo/chmod 777 不允许在子代理中执行',
 *   })
 *
 * 扩展注册的 Hook 在扩展 unload 时自动清理（通过 Registry.dispose）。
 */

import { createRegistry, type Registry } from './registry.ts'

export type HookPhase = 'before_tool_call' | 'after_tool_call'
export type HookAction = 'block' | 'warn' | 'log'

export interface Hook {
  /** Hook 唯一标识 */
  id: string
  /** 拦截时机 */
  phase: HookPhase
  /** 匹配的工具名（'*' = 所有工具） */
  tool: string
  /** 判定函数：返回 true 触发 action */
  test: (input: Record<string, unknown>) => boolean
  /** 触发动作 */
  action: HookAction
  /** 拦截/告警时的消息 */
  message: string
  /** 来源扩展（自动填充） */
  source?: string
}

export interface HookResult {
  /** 是否被拦截 */
  blocked: boolean
  /** 告警消息列表 */
  warnings: string[]
  /** 日志条目 */
  logs: Array<{ hookId: string; action: HookAction; message: string }>
}

const registry: Registry<Hook> = createRegistry()

export const hookRegistry = {
  /** 注册一个 Hook，返回 dispose 函数 */
  register(hook: Hook, source?: string): () => void {
    return registry.register(hook.id, { ...hook, source })
  },

  /** 执行所有匹配的 Hook（before_tool_call 阶段） */
  async runBefore(toolName: string, input: Record<string, unknown>): Promise<HookResult> {
    const result: HookResult = { blocked: false, warnings: [], logs: [] }
    for (const { value: hook } of registry.entries()) {
      if (hook.phase !== 'before_tool_call') continue
      if (hook.tool !== '*' && hook.tool !== toolName) continue
      try {
        if (hook.test(input)) {
          result.logs.push({ hookId: hook.id, action: hook.action, message: hook.message })
          if (hook.action === 'block') {
            result.blocked = true
            result.warnings.push(`[${hook.id}] ${hook.message}`)
          } else if (hook.action === 'warn') {
            result.warnings.push(`[${hook.id}] ${hook.message}`)
          }
        }
      } catch {
        // Hook 判定失败不阻塞主流程
      }
    }
    return result
  },

  /** 执行所有匹配的 Hook（after_tool_call 阶段，仅 log/warn，不 block） */
  runAfter(toolName: string, input: Record<string, unknown>): HookResult {
    const result: HookResult = { blocked: false, warnings: [], logs: [] }
    for (const { value: hook } of registry.entries()) {
      if (hook.phase !== 'after_tool_call') continue
      if (hook.tool !== '*' && hook.tool !== toolName) continue
      try {
        if (hook.test(input)) {
          result.logs.push({ hookId: hook.id, action: hook.action, message: hook.message })
          if (hook.action === 'warn') {
            result.warnings.push(`[${hook.id}] ${hook.message}`)
          }
        }
      } catch {
        // ignore
      }
    }
    return result
  },

  /** 列出所有已注册的 Hook */
  list(): Hook[] {
    return registry.entries().map(e => e.value)
  },

  /** 清理所有 Hook */
  clear(): void {
    registry.clear()
  },
}

// ── 内置 Hook：危险 bash 命令拦截 ──
const DANGEROUS_BASH_RE = /\brm\s+(-[rRf]+\s+|--recursive|--force)|\bsudo\b|\bchmod\s+777\b|\bmkfs\b|\bdd\s+if=|\b:(){ :\|:& };:/i
hookRegistry.register({
  id: 'block-dangerous-bash',
  phase: 'before_tool_call',
  tool: 'bash',
  test: (input) => DANGEROUS_BASH_RE.test((input.command as string) ?? ''),
  action: 'block',
  message: '危险命令被拦截（rm -rf/sudo/chmod 777/mkfs/fork bomb）',
})

// ── 内置 Hook：敏感文件写入告警 ──
const SENSITIVE_FILE_RE = /(?:auth\.json|settings\.json|models\.json|\.env|\.git\/config|private[_-]?key|id[_-]?rsa)/i
hookRegistry.register({
  id: 'warn-sensitive-file-write',
  phase: 'before_tool_call',
  tool: '*',
  test: (input) => {
    const target = (input.file_path ?? input.path ?? '') as string
    return SENSITIVE_FILE_RE.test(target)
  },
  action: 'warn',
  message: '敏感文件写入告警：请确认操作是否必要',
})

// ── 内置 Hook：外部 URL 下载告警 ──
hookRegistry.register({
  id: 'warn-external-download',
  phase: 'before_tool_call',
  tool: 'bash',
  test: (input) => /\bcurl\b|\bwget\b/.test((input.command as string) ?? '') && /\bhttps?:\/\//.test((input.command as string) ?? ''),
  action: 'log',
  message: '外部下载操作记录',
})
