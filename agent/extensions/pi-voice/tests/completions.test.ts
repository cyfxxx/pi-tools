// /voice 参数补全回归测试：顶层子命令与 device 二级补全必须可见（d30acbc 修复点）
import { describe, it, expect, vi } from 'vitest'

async function loadVoiceCommands() {
  const commands: Record<string, { getArgumentCompletions?: (p: string) => unknown[] | null; handler?: unknown }> = {}
  const api: any = {
    registerCommand: (name: string, opts: { getArgumentCompletions?: (p: string) => unknown[] | null; handler?: unknown }) => {
      commands[name] = opts
    },
    registerTool: vi.fn(),
    registerShortcut: vi.fn(),
    on: vi.fn(),
  }
  const { default: ext } = await import('../index.ts')
  ext(api)
  return commands
}

describe('/voice 参数补全', () => {
  it('顶层补全包含 device 子命令（tab/help 可见性）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    expect(voice).toBeTruthy()
    const items = voice.getArgumentCompletions?.('') ?? []
    const values = items.map((i) => (i as { value: string }).value)
    expect(values).toContain('device')
    expect(values).toContain('model')
    expect(values).toContain('tts')
  })

  it('device 后补全 cpu/gpu/auto（二级补全）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    const items = voice.getArgumentCompletions?.('device ') ?? []
    const values = items.map((i) => (i as { value: string }).value)
    expect(values).toEqual(['device cpu', 'device gpu', 'device auto'])
  })

  it('前缀 de 也能命中 device 分支（fuzzy 前置）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    const items = voice.getArgumentCompletions?.('de') ?? []
    const values = items.map((i) => (i as { value: string }).value)
    expect(values).toContain('device')
  })
})
