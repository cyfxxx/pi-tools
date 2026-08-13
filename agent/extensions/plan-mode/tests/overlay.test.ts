import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TodoOverlay } from '../overlay'
import { replaceState, resetState } from '../store'
import type { Task } from '../state'

function task(overrides: Partial<Task>): Task {
  return { id: 1, subject: '步骤', status: 'pending', ...overrides }
}

function mockUI() {
  const setWidget = vi.fn()
  const theme = { fg: (_color: string, s: string) => s }
  return { setWidget, theme }
}

beforeEach(() => {
  resetState()
})

describe('TodoOverlay: opencode todos 风格面板', () => {
  it('有未完成任务时注册 widget', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    replaceState({ tasks: [task({ id: 1, subject: '步骤一' })], nextId: 2 })
    overlay.update()
    expect(ui.setWidget).toHaveBeenCalled()
    expect(ui.setWidget.mock.calls[0][0]).toBe('plan-todos')
  })

  it('无任务时移除已注册的 widget', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    replaceState({ tasks: [task({ id: 1, subject: '步骤一' })], nextId: 2 })
    overlay.update()
    expect(ui.setWidget).toHaveBeenCalledTimes(1)
    resetState()
    overlay.update()
    expect(ui.setWidget).toHaveBeenLastCalledWith('plan-todos', undefined)
  })

  it('hide() 注销 widget 但保留 uiCtx（updateStatus 强制隐藏路径）', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    replaceState({ tasks: [task({ id: 1, subject: '步骤一' })], nextId: 2 })
    overlay.update()
    expect(ui.setWidget).toHaveBeenCalledTimes(1)
    // hide：移除 widget
    overlay.hide()
    expect(ui.setWidget).toHaveBeenLastCalledWith('plan-todos', undefined)
    // uiCtx 保留：任务还在时 update 可重建 widget（计划模式退出后恢复显示）
    overlay.update()
    expect(ui.setWidget).toHaveBeenCalledTimes(3)
    expect(ui.setWidget.mock.calls[2][0]).toBe('plan-todos')
  })

  it('全部完成时隐藏整个 widget（opencode 行为）', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    replaceState({ tasks: [task({ id: 1, subject: '步骤一' })], nextId: 2 })
    overlay.update()
    replaceState({ tasks: [task({ id: 1, status: 'completed', subject: '完成项' })], nextId: 2 })
    overlay.update()
    expect(ui.setWidget).toHaveBeenLastCalledWith('plan-todos', undefined)
  })

  it('部分完成时 widget 保留，行渲染为 [✓]/[•]/[ ] 勾选格式', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    replaceState({
      tasks: [
        task({ id: 1, status: 'completed', subject: '完成项' }),
        task({ id: 2, status: 'in_progress', subject: '当前项', activeForm: 'doing' }),
        task({ id: 3, subject: '待办项' }),
      ],
      nextId: 4,
    })
    overlay.update()
    const factory = ui.setWidget.mock.calls[0][1]
    const widget = factory({ requestRender: () => {} }, ui.theme)
    const text = widget.render(120).join('\n')
    expect(text).toContain('计划 (1/3)')
    expect(text).toContain('[✓] 完成项')
    expect(text).toContain('[•] 当前项 (doing)')
    expect(text).toContain('[ ] 待办项')
  })

  it('完成列表超出时显示 +N 更多 折叠摘要', () => {
    const ui = mockUI()
    const overlay = new TodoOverlay()
    overlay.setUICtx(ui as never)
    const tasks: Task[] = [
      task({ id: 1, status: 'completed', subject: '完成1' }),
      task({ id: 2, status: 'completed', subject: '完成2' }),
    ]
    for (let i = 3; i <= 14; i++) {
      tasks.push(task({ id: i, subject: `待办${i}` }))
    }
    replaceState({ tasks, nextId: 15 })
    overlay.update()
    const factory = ui.setWidget.mock.calls[0][1]
    const widget = factory({ requestRender: () => {} }, ui.theme)
    const text = widget.render(120).join('\n')
    expect(text).toContain('+4 更多')
  })
})
