import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// resume 分支深埋在 register() 的 slash 处理器内，完整 mock ExtensionAPI 成本过高；
// 这里用源码级断言做回归绊线：防止再次回退到硬编码工具集恢复。
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf8',
)

describe('plan-mode 工具集恢复（resume 分支回归）', () => {
  it('/plan resume 分支使用 restoreAllTools 全量恢复，不引用 NORMAL_MODE_TOOLS', () => {
    const start = src.indexOf('case "resume"')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('case "view"', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('restoreAllTools(pi)')
    expect(block).not.toContain('setActiveTools(NORMAL_MODE_TOOLS)')
    expect(block).not.toContain('setActiveTools([')
  })

  it('restoreAllTools 基于 getAllTools 动态全量恢复（扩展工具可用）', () => {
    const fnStart = src.indexOf('function restoreAllTools')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart, fnStart + 200)
    expect(body).toContain('getAllTools()')
    expect(body).toContain('setActiveTools(all)')
  })
})
