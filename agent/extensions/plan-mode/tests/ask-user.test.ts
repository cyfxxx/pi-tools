import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('plan-mode: ask_user 工具', () => {
  let mockCtx: any
  let mockPi: any
  let toolHandler: any

  beforeEach(() => {
    mockCtx = {
      ui: {
        select: vi.fn(),
      },
    }

    mockPi = {
      registerTool: vi.fn((tool: any) => {
        if (tool.name === 'ask_user') {
          toolHandler = tool
        }
      }),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      setActiveTools: vi.fn(),
      getFlag: vi.fn(),
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => []),
      exec: vi.fn(),
      events: {
        emit: vi.fn(),
        on: vi.fn(),
      },
    }
  })

  it('应该注册 ask_user 工具', async () => {
    // 动态导入以触发工具注册
    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    expect(mockPi.registerTool).toHaveBeenCalled()
    expect(toolHandler).toBeDefined()
    expect(toolHandler.name).toBe('ask_user')
  })

  it('应该有正确的参数结构', async () => {
    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    expect(toolHandler.parameters).toBeDefined()
    expect(toolHandler.parameters.type).toBe('object')
    expect(toolHandler.parameters.properties).toHaveProperty('question')
    expect(toolHandler.parameters.properties).toHaveProperty('header')
    expect(toolHandler.parameters.properties).toHaveProperty('options')
    expect(toolHandler.parameters.properties).toHaveProperty('multiple')
    expect(toolHandler.parameters.required).toContain('question')
    expect(toolHandler.parameters.required).toContain('options')
  })

  it('参数验证：缺少 question 应返回错误', async () => {
    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      { options: [{ label: '选项1' }, { label: '选项2' }] },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('question is required')
  })

  it('参数验证：options 不足 2 个应返回错误', async () => {
    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      { question: '测试问题', options: [{ label: '选项1' }] },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('at least 2 items')
  })

  it('参数验证：options 不是数组应返回错误', async () => {
    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      { question: '测试问题', options: 'not-an-array' },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('at least 2 items')
  })

  it('正常调用应显示选择器并返回选择结果', async () => {
    // 模拟用户选择后确认
    mockCtx.ui.select
      .mockResolvedValueOnce('继续执行')  // 第一次选择
      .mockResolvedValueOnce('确认')      // 确认选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '下一步要执行什么操作？',
        header: '操作选择',
        options: [
          { label: '继续执行', description: '继续执行当前任务' },
          { label: '暂停', description: '暂停执行' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(mockCtx.ui.select).toHaveBeenCalledWith('操作选择: 下一步要执行什么操作？', [
      '继续执行',
      '暂停',
    ])
    expect(result.content[0].text).toBe('继续执行')
  })

  it('选择后修改应重新显示选择器', async () => {
    // 模拟用户选择后修改，然后重新选择并确认
    mockCtx.ui.select
      .mockResolvedValueOnce('暂停')       // 第一次选择
      .mockResolvedValueOnce('修改')       // 选择修改
      .mockResolvedValueOnce('继续执行')   // 重新选择
      .mockResolvedValueOnce('确认')       // 确认选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '下一步要执行什么操作？',
        options: [
          { label: '继续执行' },
          { label: '暂停' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 应该调用了 4 次 select：选择 -> 修改 -> 重新选择 -> 确认
    expect(mockCtx.ui.select).toHaveBeenCalledTimes(4)
    expect(result.content[0].text).toBe('继续执行')
  })

  it('没有 header 时应直接使用 question 作为标题', async () => {
    // 模拟用户选择后确认
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')
      .mockResolvedValueOnce('确认')

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择一个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(mockCtx.ui.select).toHaveBeenCalledWith('请选择一个选项', ['选项A', '选项B'])
    expect(result.content[0].text).toBe('选项A')
  })

  it('用户取消选择应返回取消消息', async () => {
    // 模拟用户取消选择
    mockCtx.ui.select.mockResolvedValueOnce(undefined)

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(result.content[0].text).toBe('用户取消了选择')
  })

  it('用户取消确认应返回取消消息', async () => {
    // 模拟用户选择后取消确认
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')  // 选择
      .mockResolvedValueOnce(undefined) // 取消确认

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    expect(result.content[0].text).toBe('用户取消了选择')
  })

  it('options 中的 description 应被忽略（ctx.ui.select 不支持）', async () => {
    // 模拟用户选择后确认
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')
      .mockResolvedValueOnce('确认')

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择',
        options: [
          { label: '选项A', description: '这是选项A的描述' },
          { label: '选项B', description: '这是选项B的描述' },
        ],
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // description 不应传递给 ctx.ui.select
    expect(mockCtx.ui.select).toHaveBeenCalledWith('请选择', ['选项A', '选项B'])
    expect(result.content[0].text).toBe('选项A')
  })

  it('多选模式：应支持逐个选择直到完成', async () => {
    // 模拟用户选择两个选项后完成
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')   // 选择选项A
      .mockResolvedValueOnce('选项B')   // 选择选项B
      .mockResolvedValueOnce('完成选择') // 完成选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择多个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
          { label: '选项C' },
        ],
        multiple: true,
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 应该返回逗号分隔的选项
    expect(result.content[0].text).toBe('选项A, 选项B')
  })

  it('多选模式：点击已选选项应取消选择', async () => {
    // 模拟用户选择后取消某个选项
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')     // 选择选项A
      .mockResolvedValueOnce('✓ 选项A')   // 点击已选的选项A（取消）
      .mockResolvedValueOnce('选项B')     // 选择选项B
      .mockResolvedValueOnce('完成选择')   // 完成选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择多个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
        multiple: true,
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 选项A被取消，只返回选项B
    expect(result.content[0].text).toBe('选项B')
  })

  it('多选模式：取消全部应清空已选择', async () => {
    // 模拟用户选择后取消全部
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')   // 选择选项A
      .mockResolvedValueOnce('取消全部') // 取消全部
      .mockResolvedValueOnce('选项B')   // 重新选择选项B
      .mockResolvedValueOnce('完成选择') // 完成选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择多个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
        multiple: true,
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 取消全部后重新选择，应该只返回选项B
    expect(result.content[0].text).toBe('选项B')
  })

  it('多选模式：未选择任何选项时完成应提示', async () => {
    // 模拟用户直接选择完成
    mockCtx.ui.select
      .mockResolvedValueOnce('完成选择') // 直接完成
      .mockResolvedValueOnce('选项A')   // 选择选项A
      .mockResolvedValueOnce('完成选择') // 完成选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    const result = await toolHandler.execute(
      'test-id',
      {
        question: '请选择多个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
        multiple: true,
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 第一次完成时没有选项，应该继续循环
    expect(mockCtx.ui.select).toHaveBeenCalledTimes(3)
    expect(result.content[0].text).toBe('选项A')
  })

  it('多选模式：已选选项显示✓标记', async () => {
    // 模拟用户选择后查看状态
    mockCtx.ui.select
      .mockResolvedValueOnce('选项A')     // 选择选项A
      .mockResolvedValueOnce('完成选择')   // 完成选择

    const { default: planModeExtension } = await import('../index.ts')
    planModeExtension(mockPi)

    await toolHandler.execute(
      'test-id',
      {
        question: '请选择多个选项',
        options: [
          { label: '选项A' },
          { label: '选项B' },
        ],
        multiple: true,
      },
      new AbortController().signal,
      vi.fn(),
      mockCtx,
    )

    // 第二次调用时应该显示 ✓ 选项A
    const secondCallOptions = mockCtx.ui.select.mock.calls[1][1]
    expect(secondCallOptions).toContain('✓ 选项A')
    expect(secondCallOptions).toContain('选项B')
  })
})
