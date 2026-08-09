import { describe, it, expect } from 'vitest'
import { EFFICIENCY_ADVICE } from '../index.ts'

describe('EFFICIENCY_ADVICE 静态注入文案', () => {
  it('包含批量工具调用指令', () => {
    expect(EFFICIENCY_ADVICE).toMatch(/batch them together/i)
    expect(EFFICIENCY_ADVICE).toMatch(/single assistant turn/i)
    expect(EFFICIENCY_ADVICE).toMatch(/one request/i)
  })

  it('包含抑制中间答复指令', () => {
    expect(EFFICIENCY_ADVICE).toMatch(/do NOT write explanatory text/i)
    expect(EFFICIENCY_ADVICE).toMatch(/Summarize once/i)
  })

  it('包含 plan 摘要例外,不误伤 plan-mode 要求', () => {
    expect(EFFICIENCY_ADVICE).toMatch(/plan summary is requested/i)
  })

  it('缓存友好: 不含时间戳与精确数值', () => {
    expect(EFFICIENCY_ADVICE).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(EFFICIENCY_ADVICE).not.toMatch(/\d+%/)
  })
})
