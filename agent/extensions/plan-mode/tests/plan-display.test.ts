import { describe, it, expect } from 'vitest'
import type { Task } from '../state.ts'
import { formatPlanMessageLine, STATUS_GLYPH } from '../view.ts'
import { truncateSubject } from '../utils.ts'

function task(overrides: Partial<Task>): Task {
  return { id: 1, subject: '步骤', status: 'pending', ...overrides }
}

describe('plan-mode: truncateSubject 名称截断', () => {
  it('短名称原样保留', () => {
    expect(truncateSubject('修复登录页样式')).toBe('修复登录页样式')
  })

  it('空白折叠（多空格/换行合并为单空格）', () => {
    expect(truncateSubject('  修复  登录 页\n样式  ')).toBe('修复 登录 页 样式')
  })

  it('超过 40 字符截断并加省略号', () => {
    const long = '为 pi 的 plan-mode 扩展增加计划步骤名称的截断显示以及实时进度消息推送'
    const out = truncateSubject(long)
    expect(out.length).toBe(40)
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith(long.slice(0, 20))).toBe(true)
  })

  it('空值安全', () => {
    expect(truncateSubject('')).toBe('')
    expect(truncateSubject(undefined as unknown as string)).toBe('')
  })
})

describe('plan-mode: formatPlanMessageLine 勾选行（opencode todos 风格）', () => {
  it('pending → [ ]', () => {
    expect(formatPlanMessageLine(task({ id: 1, subject: '第一步' }))).toBe('1. [ ] 第一步')
  })

  it('in_progress → [•] 并带 activeForm', () => {
    expect(
      formatPlanMessageLine(task({ id: 2, status: 'in_progress', subject: '第二步', activeForm: '正在改 config' })),
    ).toBe('2. [•] 第二步 (正在改 config)')
  })

  it('completed → [✓]', () => {
    expect(formatPlanMessageLine(task({ id: 3, status: 'completed', subject: '第三步' }))).toBe('3. [✓] 第三步')
  })

  it('blocked → [⏸]', () => {
    expect(formatPlanMessageLine(task({ id: 4, status: 'blocked', subject: '第四步' }))).toBe('4. [⏸] 第四步')
  })

  it('超长名称截断到 40 字符', () => {
    const long = '为 pi 的 plan-mode 扩展增加计划步骤名称的截断显示以及实时进度消息推送'
    const line = formatPlanMessageLine(task({ subject: long }))
    expect(line.length).toBeLessThan(60)
    expect(line).toContain('…')
  })
})

describe('plan-mode: STATUS_GLYPH 映射完整性', () => {
  it('覆盖所有任务状态', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'blocked', 'deleted'] as const) {
      expect(STATUS_GLYPH[status]).toBeTruthy()
    }
  })
})
