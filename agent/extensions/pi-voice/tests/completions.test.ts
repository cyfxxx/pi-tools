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

  it('tts speak 带自由文本时返回空（回车不被补全劫持，2026-08-15 回归）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    // 输入 'tts speak 你好' 回车应直接提交命令，补全弹窗必须关闭
    expect(voice.getArgumentCompletions?.('tts speak 你好') ?? []).toEqual([])
    expect(voice.getArgumentCompletions?.('tts speak 你好呀') ?? []).toEqual([])
    // 完整子命令同样排除（'tts on' 回车直接执行）
    expect(voice.getArgumentCompletions?.('tts on') ?? []).toEqual([])
  })

  it('tts 前缀匹配仍补全（on/off/status，无 speak 字面量项）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    const all = (voice.getArgumentCompletions?.('tts ') ?? []).map((i) => (i as { value: string }).value)
    expect(all).toEqual(['tts on', 'tts off', 'tts status'])
    const o = (voice.getArgumentCompletions?.('tts o') ?? []).map((i) => (i as { value: string }).value)
    expect(o).toEqual(['tts on', 'tts off'])
    const s = (voice.getArgumentCompletions?.('tts s') ?? []).map((i) => (i as { value: string }).value)
    expect(s).toEqual(['tts status'])
  })

  it('model/device 完整匹配回车直接提交（弹窗关闭）', async () => {
    const cmds = await loadVoiceCommands()
    const voice = cmds['voice']
    expect(voice.getArgumentCompletions?.('model small') ?? []).toEqual([])
    expect(voice.getArgumentCompletions?.('device cpu') ?? []).toEqual([])
    expect(voice.getArgumentCompletions?.('device gpu') ?? []).toEqual([])
  })
})
