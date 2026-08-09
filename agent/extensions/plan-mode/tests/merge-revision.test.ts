import { describe, it, expect } from 'vitest'
import type { Task, TaskState } from '../state.ts'
import { mergePlanRevision, normalizeSubject } from '../utils.ts'

function state(tasks: Task[], nextId = tasks.length + 1): TaskState {
  return { tasks, nextId }
}

function step(subject: string): Task {
  return { id: 0, subject, status: 'pending' }
}

describe('plan-mode: normalizeSubject 规范化', () => {
  it('小写、去标点、折叠空白', () => {
    expect(normalizeSubject(' 修复 Login 页面的样式！？ ')).toBe('修复 login 页面的样式')
  })
  it('中英文混合保留字母数字', () => {
    expect(normalizeSubject('Step 1: 写测试')).toBe('step 1 写测试')
  })
  it('空值安全', () => {
    expect(normalizeSubject('')).toBe('')
    expect(normalizeSubject(undefined as unknown as string)).toBe('')
  })
})

describe('plan-mode: mergePlanRevision 修订替换语义', () => {
  it('完全匹配的步骤保留原 id 与状态', () => {
    const s = state([
      { id: 1, subject: '修复登录页样式', status: 'in_progress', activeForm: '正在改 CSS' },
      { id: 2, subject: '补测试', status: 'pending' },
    ])
    const { tasks, added, removed } = mergePlanRevision(s, [
      step('修复登录页样式'),
      step('补测试'),
    ])
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toMatchObject({ id: 1, subject: '修复登录页样式', status: 'in_progress', activeForm: '正在改 CSS' })
    expect(tasks[1]).toMatchObject({ id: 2, subject: '补测试', status: 'pending' })
    expect(added).toHaveLength(0)
    expect(removed).toHaveLength(0)
  })

  it('修订：移除未匹配 pending，追加新步骤，nextId 推进', () => {
    const s = state([
      { id: 1, subject: '旧步骤甲', status: 'pending' },
      { id: 2, subject: '旧步骤乙', status: 'pending' },
    ])
    const { tasks, nextId, added, removed } = mergePlanRevision(s, [
      step('旧步骤乙'),
      step('全新步骤丙'),
    ])
    expect(tasks.map((t) => t.subject)).toEqual(['旧步骤乙', '全新步骤丙'])
    expect(nextId).toBe(4)
    expect(added.map((t) => t.subject)).toEqual(['全新步骤丙'])
    expect(removed.map((t) => t.subject)).toEqual(['旧步骤甲'])
    expect(removed[0].id).toBe(1)
  })

  it('in_progress 未匹配降为 pending 保留，blocked 保留原状态', () => {
    const s = state([
      { id: 1, subject: '进行中的步骤', status: 'in_progress', activeForm: '正在做' },
      { id: 2, subject: '阻塞的步骤', status: 'blocked' },
    ])
    const { tasks } = mergePlanRevision(s, [step('全新步骤')])
    expect(tasks).toHaveLength(3)
    expect(tasks.find((t) => t.id === 1)).toMatchObject({ status: 'pending', activeForm: undefined })
    expect(tasks.find((t) => t.id === 2)).toMatchObject({ status: 'blocked' })
  })

  it('completed/deleted 始终保留且不参与匹配', () => {
    const s = state([
      { id: 1, subject: '已完成步骤', status: 'completed' },
      { id: 2, subject: '待办步骤', status: 'pending' },
    ])
    const { tasks, added } = mergePlanRevision(s, [step('已完成步骤'), step('待办步骤')])
    // completed 不匹配新版（保留原样）；待办步骤匹配保留
    expect(tasks).toHaveLength(3)
    expect(tasks.find((t) => t.id === 1)).toMatchObject({ subject: '已完成步骤', status: 'completed' })
    expect(tasks.find((t) => t.id === 2)).toMatchObject({ subject: '待办步骤', status: 'pending' })
    expect(added).toHaveLength(1) // 新"已完成步骤"作为新步骤追加
  })

  it('微变表述经相似度兜底匹配（Dice ≥ 0.7）', () => {
    const s = state([{ id: 1, subject: '修复登录页的样式问题', status: 'pending' }])
    const { tasks, added, removed } = mergePlanRevision(s, [step('修复登录页样式')])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 1, status: 'pending' })
    expect(tasks[0].subject).toBe('修复登录页样式') // subject 更新为新文本
    expect(added).toHaveLength(0)
    expect(removed).toHaveLength(0)
  })

  it('语义不同但字符相近不误配（低于阈值，替换语义下旧 pending 移除）', () => {
    const s = state([{ id: 1, subject: '写数据库迁移脚本', status: 'pending' }])
    const { tasks, added, removed } = mergePlanRevision(s, [step('写单元测试脚本')])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 2, subject: '写单元测试脚本' })
    expect(added).toHaveLength(1)
    expect(removed.map((t) => t.id)).toEqual([1])
  })

  it('顺序变化不影响匹配结果', () => {
    const s = state([
      { id: 1, subject: '步骤甲', status: 'pending' },
      { id: 2, subject: '步骤乙', status: 'pending' },
    ])
    const { tasks } = mergePlanRevision(s, [step('步骤乙'), step('步骤甲')])
    expect(tasks.map((t) => t.id)).toEqual([2, 1])
  })

  it('空状态直接创建全部新步骤', () => {
    const s = state([])
    const { tasks, nextId, added } = mergePlanRevision(s, [step('步骤一'), step('步骤二')])
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.id)).toEqual([1, 2])
    expect(nextId).toBe(3)
    expect(added).toHaveLength(2)
  })

  it('重复步骤（新版中出现两次）第二次追加为新任务', () => {
    const s = state([{ id: 1, subject: '步骤甲', status: 'pending' }])
    const { tasks, added } = mergePlanRevision(s, [step('步骤甲'), step('步骤甲')])
    expect(tasks).toHaveLength(2)
    expect(added).toHaveLength(1)
  })
})
