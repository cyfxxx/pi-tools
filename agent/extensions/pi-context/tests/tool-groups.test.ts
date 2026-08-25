import { describe, it, expect } from 'vitest'
import {
  CORE_TOOLS,
  SLEEPING_GROUPS,
  SLEEPING_TOOL_SET,
  buildSleepingSummary,
  computeActiveTools,
  validateGroups,
} from '../tool-groups.ts'

describe('tool-groups: 分层完整性', () => {
  it('核心与休眠组无重叠，无空组', () => {
    const { overlap, emptyGroups } = validateGroups()
    expect(overlap).toEqual([])
    expect(emptyGroups).toEqual([])
  })

  it('核心包含全部内置工具', () => {
    for (const t of ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']) {
      expect(CORE_TOOLS).toContain(t)
    }
  })

  it('休眠组覆盖已知低频工具（去重后无重复）', () => {
    const all = SLEEPING_GROUPS.flatMap((g) => g.tools)
    expect(new Set(all).size).toBe(all.length) // 无重复
    expect(SLEEPING_TOOL_SET.size).toBe(all.length)
    // 关键低频工具都在休眠组
    for (const t of ['admin_set_config', 'admin_status', 'autopilot_status', 'schedule_task', 'browser_navigate', 'link_send']) {
      expect(SLEEPING_TOOL_SET.has(t)).toBe(true)
    }
    // 高频单工具常驻：admin_restart 重启高频且 schema 极小，不进休眠组
    expect(CORE_TOOLS).toContain('admin_restart')
    expect(SLEEPING_TOOL_SET.has('admin_restart')).toBe(false)
  })
})

describe('tool-groups: computeActiveTools', () => {
  const all = [...CORE_TOOLS, ...SLEEPING_GROUPS.flatMap((g) => g.tools)]

  it('未启用任何组时排除全部休眠工具', () => {
    const active = computeActiveTools(all, new Set())
    expect(active).toEqual(CORE_TOOLS)
    expect(active).toHaveLength(CORE_TOOLS.length)
  })

  it('启用单组只恢复该组工具', () => {
    const active = computeActiveTools(all, new Set(['browser']))
    expect(active).toContain('browser_navigate')
    expect(active).toContain('browser_close')
    expect(active).not.toContain('admin_status')
    expect(active).not.toContain('link_send')
  })

  it('启用多组全部恢复', () => {
    const active = computeActiveTools(all, new Set(['browser', 'admin', 'autopilot', 'link']))
    expect(active).toHaveLength(all.length)
  })

  it('未知工具（未来新扩展）默认保留（不依赖名单完整性）', () => {
    const all2 = [...all, 'future_tool_x']
    const active = computeActiveTools(all2, new Set())
    expect(active).toContain('future_tool_x')
  })
})

describe('tool-groups: 缓存友好性', () => {
  it('简介内容不依赖启用状态（静态，前缀稳定）', () => {
    const s1 = buildSleepingSummary()
    const s2 = buildSleepingSummary()
    expect(s1).toBe(s2)
    expect(s1).toContain('browser')
    expect(s1).toContain('admin')
    expect(s1).toContain('autopilot')
    expect(s1).toContain('link')
    // 无时间戳/精确数值（缓存友好约束）
    expect(s1).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
