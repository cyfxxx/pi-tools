import { describe, it, expect } from 'vitest'
import { applyTaskMutation } from '../state.ts'

describe('plan-mode: 失败记录持久化（P2）', () => {
  it('update 追加 failure 记录（append-only）', () => {
    const empty = { tasks: [], nextId: 1 }
    const c = applyTaskMutation(empty, 'create', { subject: '任务A' })
    const r1 = applyTaskMutation(c.state, 'update', { id: 1, failure: 'pip SSL 超时' })
    expect(r1.state.tasks[0].failures).toEqual(['pip SSL 超时'])
    const r2 = applyTaskMutation(r1.state, 'update', { id: 1, failure: '改用镜像源' })
    expect(r2.state.tasks[0].failures).toEqual(['pip SSL 超时', '改用镜像源'])
    expect(r2.op).toMatchObject({ kind: 'update', failure: '改用镜像源' })
  })

  it('failures 最多保留 3 条（滚动裁剪）', () => {
    const empty = { tasks: [], nextId: 1 }
    let state = applyTaskMutation(empty, 'create', { subject: '任务B' }).state
    for (let i = 1; i <= 5; i++) {
      state = applyTaskMutation(state, 'update', { id: 1, failure: `失败${i}` }).state
    }
    expect(state.tasks[0].failures).toEqual(['失败3', '失败4', '失败5'])
  })

  it('update 无 mutation 字段时报错（failure 也算 mutation）', () => {
    const empty = { tasks: [], nextId: 1 }
    const c = applyTaskMutation(empty, 'create', { subject: '任务C' }).state
    const r = applyTaskMutation(c, 'update', { id: 1, failure: 'x' })
    expect(r.op.kind).not.toBe('error')
  })
})
