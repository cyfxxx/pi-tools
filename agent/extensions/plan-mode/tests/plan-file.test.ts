import { describe, it, expect } from 'vitest'
import { renderPlanFile, parsePlanFile } from '../view.ts'
import type { Task } from '../state.ts'

describe('plan-mode: 计划文件持久化（P1）', () => {
  const tasks = [
    { id: 1, subject: '调研方案', status: 'completed' },
    { id: 2, subject: '实现 A3', status: 'in_progress', activeForm: '正在编码' },
    { id: 3, subject: '跑测试', status: 'blocked' },
    { id: 4, subject: '推送', status: 'pending' },
    { id: 5, subject: '已删除任务', status: 'deleted' },
  ] as any

  it('renderPlanFile 输出可解析格式（deleted 排除）', () => {
    const text = renderPlanFile(tasks, 6)
    expect(text).toContain('- [x] 1. 调研方案')
    expect(text).toContain('- [~] 2. 实现 A3 (正在编码)')
    expect(text).toContain('- [b] 3. 跑测试')
    expect(text).toContain('- [ ] 4. 推送')
    expect(text).not.toContain('已删除任务')
    expect(text).toContain('<!-- nextId: 6 -->')
  })

  it('parsePlanFile 还原任务状态与 nextId（往返一致）', () => {
    const text = renderPlanFile(tasks, 6)
    const restored = parsePlanFile(text)
    expect(restored).not.toBeNull()
    expect(restored!.tasks).toHaveLength(4)
    expect(restored!.tasks[0]).toMatchObject({ id: 1, status: 'completed' })
    expect(restored!.tasks[1]).toMatchObject({ id: 2, status: 'in_progress', activeForm: '正在编码' })
    expect(restored!.tasks[2]).toMatchObject({ id: 3, status: 'blocked' })
    expect(restored!.tasks[3]).toMatchObject({ id: 4, status: 'pending' })
    expect(restored!.nextId).toBe(6)
  })

  it('parsePlanFile 拒绝手改污染（非任务行过半）', () => {
    const garbage = '# 手写计划\n\n- [ ] 9. 唯一任务\n\n这里是一些自由文本\n还有更多说明文字\n甚至更多内容\n'
    expect(parsePlanFile(garbage)).toBeNull()
  })

  it('parsePlanFile 单任务计划可恢复（3 非空行：标题+任务+nextId）', () => {
    const tasks: Task[] = [{ id: 1, subject: '唯一任务', status: 'pending' }]
    const text = renderPlanFile(tasks, 2)
    const restored = parsePlanFile(text)
    expect(restored).not.toBeNull()
    expect(restored!.tasks).toHaveLength(1)
    expect(restored!.tasks[0]).toMatchObject({ id: 1, status: 'pending' })
    expect(restored!.nextId).toBe(2)
  })

  it('parsePlanFile 拒绝空文件', () => {
    expect(parsePlanFile('# 空\n')).toBeNull()
  })
})
