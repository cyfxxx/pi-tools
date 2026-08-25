import { describe, it, expect } from 'vitest'
import { applyPreviousPlaceholder, capPreviousOutput, getResultOutput, isFailedResult } from '../index.ts'

const KB = 1024
// Linux 单个 argv 参数上限 MAX_ARG_STRLEN = 32 页 = 128KB（spawn E2BIG 阈值）
const MAX_ARG_STRLEN = 128 * KB
const CAP = 96 * KB

const baseResult = {
  agent: 'a',
  agentSource: 'user' as const,
  task: 't',
  exitCode: 0,
  messages: [],
  stderr: '',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
}

// 审计 HIGH：链式 {previous} 注入上一步全文无截断——超过 MAX_ARG_STRLEN(128KB)
// 时 spawn 抛 E2BIG，且 proc error handler 此前静默 resolve(1)，整链无声失败。
describe('subagent: chain {previous} 注入安全上限（E2BIG 回归）', () => {
  it('未超上限的输出原样透传（含恰好等于上限）', () => {
    expect(capPreviousOutput('hello')).toBe('hello')
    expect(capPreviousOutput('x'.repeat(CAP))).toBe('x'.repeat(CAP))
    expect(capPreviousOutput('')).toBe('')
  })

  it('超上限截断保留头部并附 [truncated] 标记，总字节受控', () => {
    const big = 'y'.repeat(10 * 1024 * KB) // 10MB 上一步输出
    const capped = capPreviousOutput(big)
    expect(capped.endsWith('[truncated]')).toBe(true)
    expect(capped.startsWith('yyyy')).toBe(true)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(CAP + Buffer.byteLength('\n[truncated]', 'utf8'))
  })

  it('多字节字符截断不产生 U+FFFD 乱码（字节边界回退）', () => {
    const big = '啊'.repeat(100 * KB) // 3 字节/字；cap=96001 必切断一个字符
    const capped = capPreviousOutput(big, 96 * KB + 1)
    expect(capped.endsWith('[truncated]')).toBe(true)
    expect(capped.includes('\uFFFD')).toBe(false)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(96 * KB + Buffer.byteLength('\n[truncated]', 'utf8'))
  })

  it('applyPreviousPlaceholder 注入超大 previous 时整体参数 < MAX_ARG_STRLEN', () => {
    const task = '请基于以下输出继续分析:\n{previous}\n结尾'
    const injected = applyPreviousPlaceholder(task, 'y'.repeat(10 * 1024 * KB))
    // 关键不变量：拼好的 Task 参数永不触发 spawn E2BIG
    expect(Buffer.byteLength(injected, 'utf8')).toBeLessThan(MAX_ARG_STRLEN)
    expect(injected).toContain('[truncated]')
    expect(injected.startsWith('请基于以下输出继续分析')).toBe(true)
    expect(injected.endsWith('结尾')).toBe(true)
  })

  it('小输出占位符行为不变（无副作用回归）', () => {
    expect(applyPreviousPlaceholder('A {previous} B', 'out')).toBe('A out B')
    expect(applyPreviousPlaceholder('{previous} + {previous}', '$&')).toBe('$& + $&')
  })
})

// error handler 透传契约：spawn 失败时写入 errorMessage/stderr 后 resolve(1)，
// 经 isFailedResult → getResultOutput 把原因带回主会话（此前静默丢失）
describe('subagent: spawn 错误信息透传契约', () => {
  it('失败结果优先返回 errorMessage（可诊断 E2BIG/ENOENT）', () => {
    const r = { ...baseResult, exitCode: 1, errorMessage: '子进程启动失败: spawn node E2BIG' }
    expect(isFailedResult(r)).toBe(true)
    expect(getResultOutput(r)).toContain('E2BIG')
    expect(getResultOutput(r)).toContain('子进程启动失败')
  })

  it('errorMessage 缺失时回退 stderr（既有语义不回归）', () => {
    const r = { ...baseResult, exitCode: 1, stderr: 'boom' }
    expect(getResultOutput(r)).toContain('boom')
  })
})
