import { describe, it, expect } from 'vitest'
import { assertPlanSubagentAllowed } from '../utils.ts'

describe('assertPlanSubagentAllowed 规划模式 subagent 拦截', () => {
  it('放行显式 scout 单任务', () => {
    expect(assertPlanSubagentAllowed({ agent: 'scout', task: '找 x 定义' })).toBeNull()
  })

  it('放行 parallel 全部 scout', () => {
    const input = { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'scout', task: 'b' }] }
    expect(assertPlanSubagentAllowed(input)).toBeNull()
  })

  it('放行 chain 全部 scout', () => {
    const input = { chain: [{ agent: 'scout', task: 'a' }, { agent: 'scout', task: 'b' }] }
    expect(assertPlanSubagentAllowed(input)).toBeNull()
  })

  it('拒绝 worker/reviewer', () => {
    expect(assertPlanSubagentAllowed({ agent: 'worker', task: 'x' })).toBeTypeOf('string')
    expect(assertPlanSubagentAllowed({ agent: 'reviewer', task: 'x' })).toMatch(/仅允许显式指定/)
  })

  it('拒绝未指定代理的默认 general-purpose（全工具可写）', () => {
    expect(assertPlanSubagentAllowed({ task: 'x' })).toMatch(/仅允许显式指定/)
  })

  it('parallel/chain 混入非 scout 即拒绝', () => {
    expect(assertPlanSubagentAllowed({ tasks: [{ agent: 'scout', task: 'a' }, { task: 'b' }] })).toMatch(/scout/)
    expect(assertPlanSubagentAllowed({ chain: [{ agent: 'worker', task: 'a' }] })).toMatch(/scout/)
  })
})