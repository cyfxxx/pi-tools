import { describe, it, expect } from 'vitest'
import { extractTodoItems, isPlanRevisionIntent } from '../utils.ts'

describe('plan-mode: extractTodoItems Plan 头收紧', () => {
  it('正常 "Plan:" 头提取', () => {
    const items = extractTodoItems(`计划如下:\n\nPlan:\n1. 编写单元测试\n2. 运行全量回归\n`)
    expect(items.map((i) => i.subject)).toEqual(['编写单元测试', '运行全量回归'])
  })

  it('中文 "计划：" 头提取', () => {
    const items = extractTodoItems(`计划：\n1. 修复登录页样式\n`)
    expect(items.map((i) => i.subject)).toEqual(['修复登录页样式'])
  })

  it('星号闭合 "**Plan**：" 头提取', () => {
    const items = extractTodoItems(`**Plan**：\n1. 重构支付模块\n`)
    expect(items.map((i) => i.subject)).toEqual(['重构支付模块'])
  })

  it('"**plan-mode 修订语义**" 复合词不误命中（大小写不敏感 + 无冒号/空白）', () => {
    const items = extractTodoItems(`记录 footer 口径、**plan-mode 修订语义**、注入消息缓存特性。\n\n1. 编写单元测试\n2. 运行全量回归\n`)
    expect(items).toHaveLength(0)
  })

  it('"**计划步骤 (0/9):**" 聊天展示行不误命中', () => {
    const items = extractTodoItems(`**计划步骤 (0/9):**\n\n1. [ ] 步骤甲处理\n2. [ ] 步骤乙处理\n`)
    expect(items).toHaveLength(0)
  })

  it('"Plan-mode：27 通过" 行尾中文冒号不误命中（Plan 后为连字符）', () => {
    const items = extractTodoItems(`**Plan-mode：27 通过**\n\n1. 编写单元测试\n`)
    expect(items).toHaveLength(0)
  })

  it('"Plan 如下" 无冒号但后跟空格的宽松格式仍提取', () => {
    const items = extractTodoItems(`Plan 如下\n1. 处理登录页的问题\n`)
    expect(items.map((i) => i.subject)).toEqual(['处理登录页的问题'])
  })
})

describe('plan-mode: isPlanRevisionIntent 修订意图', () => {
  it('用户明确要求修改时判定为修订', () => {
    expect(isPlanRevisionIntent('把计划第 2 步改成先写测试')).toBe(true)
    expect(isPlanRevisionIntent('重新计划一下，增加部署步骤')).toBe(true)
    expect(isPlanRevisionIntent('remove the third step please')).toBe(true)
  })

  it('无动作词的汇报/总结文本不判定为修订', () => {
    expect(isPlanRevisionIntent('汇报：已完成 3 步，剩余 2 步')).toBe(false)
    expect(isPlanRevisionIntent('本次改动共涉及 4 个文件，全量回归通过')).toBe(false)
  })

  it('疑问/澄清类消息不判定为修订', () => {
    expect(isPlanRevisionIntent('为什么第 2 步要这样做？')).toBe(false)
    expect(isPlanRevisionIntent('解释一下第 1 步的含义')).toBe(false)
  })

  it('普通执行指令（继续/下一步）不判定为修订', () => {
    expect(isPlanRevisionIntent('继续执行')).toBe(false)
    expect(isPlanRevisionIntent('下一步')).toBe(false)
    expect(isPlanRevisionIntent('执行计划。从以下步骤开始: 修复样式')).toBe(false)
  })

  it('plan-mode 自身消息副本（用户转发/引用）不判定为修订', () => {
    expect(isPlanRevisionIntent('**计划已修订** — 未完成任务已替换为 2 个新步骤：\n\n1. Plan 头正则收紧\n2. 修订意图判定源改为用户消息')).toBe(false)
    expect(isPlanRevisionIntent('**计划进度 (0/2):**\n(无进行中步骤)\n剩余 2 步')).toBe(false)
    expect(isPlanRevisionIntent('**计划步骤 (0/9):**\n\n1. [ ] 步骤甲处理\n2. [ ] 步骤乙处理')).toBe(false)
    expect(isPlanRevisionIntent('**计划完成!** ✓\n\n~~步骤甲~~')).toBe(false)
  })
})
