import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

const registeredTools: Array<{ name: string; execute: Function }> = []
const lifecycleHandlers: Record<string, Function> = {}

const mockPi = {
  registerTool: vi.fn((tool: { name: string; execute: Function }) => {
    registeredTools.push({ name: tool.name, execute: tool.execute })
  }),
  on: vi.fn((event: string, handler: Function) => {
    lifecycleHandlers[event] = handler
  }),
}

vi.mock('../config', () => ({
  loadConfig: () => ({
    browser: { headless: false, viewport_width: 1280, viewport_height: 800 },
  }),
}))

// Mock cloakbrowser
vi.mock('cloakbrowser', () => ({
  launch: vi.fn().mockResolvedValue({
    isConnected: vi.fn().mockReturnValue(true),
    newPage: vi.fn().mockResolvedValue({
      isClosed: vi.fn().mockReturnValue(false),
      goto: vi.fn().mockResolvedValue(undefined),
      setViewportSize: vi.fn(),
      url: vi.fn().mockReturnValue('about:blank'),
      title: vi.fn().mockResolvedValue(''),
      content: vi.fn().mockResolvedValue('<html></html>'),
      evaluate: vi.fn().mockResolvedValue({ text: '', headings: [], paragraphs: [] }),
      screenshot: vi.fn().mockResolvedValue('/tmp/test-screenshot.png'),
      close: vi.fn(),
      mouse: { click: vi.fn() },
      fill: vi.fn(),
      keyboard: { type: vi.fn() },
      $: vi.fn(),
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 800 }),
    }),
    close: vi.fn(),
  }),
}))

describe('pi-browser (entry point)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredTools.length = 0
    Object.keys(lifecycleHandlers).forEach(k => delete lifecycleHandlers[k])
  })

  it('should register browser tools and lifecycle hooks', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const toolNames = registeredTools.map(t => t.name).sort()
    expect(toolNames).toEqual([
      'browser_click', 'browser_close', 'browser_cookies', 'browser_dialog',
      'browser_download', 'browser_evaluate', 'browser_extract', 'browser_find',
      'browser_help', 'browser_navigate', 'browser_network', 'browser_pdf',
      'browser_screenshot', 'browser_scroll', 'browser_select_option',
      'browser_type', 'browser_upload', 'browser_wait_for',
    ].sort())

    expect(lifecycleHandlers['session_shutdown']).toBeDefined()
    expect(lifecycleHandlers['session_compact']).toBeDefined()
    expect(lifecycleHandlers['session_start']).toBeDefined()
  })

  it('browser_help should return interaction manual section', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const tool = registeredTools.find(t => t.name === 'browser_help')!
    const r = await tool.execute('id', { topic: 'shadow' }, undefined, undefined, {} as any)
    expect(r.content[0].text).toContain('Shadow DOM')

    const full = await tool.execute('id', {}, undefined, undefined, {} as any)
    expect(full.content[0].text).toContain('Web 交互操作手册')
  })

  it('browser_navigate should return page info', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const navTool = registeredTools.find(t => t.name === 'browser_navigate')!
    const result = await navTool.execute('id', {
      url: 'https://example.com',
    }, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('页面标题')
  })

  it('should handle screenshot tool', async () => {
    const main = (await import('../index')).default
    await main(mockPi as any)

    const navTool = registeredTools.find(t => t.name === 'browser_navigate')!
    await navTool.execute('id', { url: 'https://example.com' }, undefined, undefined, {} as any)

    const ssTool = registeredTools.find(t => t.name === 'browser_screenshot')!
    const result = await ssTool.execute('id', {}, undefined, undefined, {} as any)

    expect(result.content[0].text).toContain('截图已保存')
  })

  it('should clean screenshots on session_shutdown', async () => {
    const fs = await import('fs/promises')
    // 审计 LOW：截图目录进程专属（含 pid）——cleanScreenshots 只清本进程子目录
    const shotDir = join(tmpdir(), `pi-browser-screenshots-${process.pid}`)
    await fs.mkdir(shotDir, { recursive: true })
    const testFile = join(shotDir, 'pi-screenshot-test-clean.png')
    await fs.writeFile(testFile, 'test')

    const main = (await import('../index')).default
    await main(mockPi as any)

    await lifecycleHandlers['session_shutdown']()

    const exists = await fs.access(testFile).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('cleanScreenshots 只清本进程子目录，不触碰其他进程目录（审计 LOW：跨进程误删防护）', async () => {
    const fs = await import('fs/promises')
    const ownDir = join(tmpdir(), `pi-browser-screenshots-${process.pid}`)
    const otherDir = join(tmpdir(), 'pi-browser-screenshots-otherproc')
    await fs.mkdir(ownDir, { recursive: true })
    await fs.mkdir(otherDir, { recursive: true })
    const ownFile = join(ownDir, 'pi-screenshot-own.png')
    const otherFile = join(otherDir, 'pi-screenshot-other.png')
    await fs.writeFile(ownFile, 'test')
    await fs.writeFile(otherFile, 'test')

    const main = (await import('../index')).default
    await main(mockPi as any)

    await lifecycleHandlers['session_shutdown']()

    // 本进程文件被清，其他进程目录文件保留
    expect(await fs.access(ownFile).then(() => true).catch(() => false)).toBe(false)
    expect(await fs.access(otherFile).then(() => true).catch(() => false)).toBe(true)

    await fs.unlink(otherFile).catch(() => {})
    await fs.rmdir(otherDir).catch(() => {})
  })

  it('should trim screenshots on session_compact', async () => {
    const fs = await import('fs/promises')
    const shotDir = join(tmpdir(), `pi-browser-screenshots-${process.pid}`)
    await fs.mkdir(shotDir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(join(shotDir, `pi-screenshot-test-compact-${i}.png`), 'test')
    }

    const main = (await import('../index')).default
    await main(mockPi as any)

    await lifecycleHandlers['session_compact']()

    const files = (await fs.readdir(shotDir))
      .filter(f => f.startsWith('pi-screenshot-test-compact-'))
    expect(files.length).toBeLessThanOrEqual(20)

    await Promise.all(files.map(f => fs.unlink(join(shotDir, f))))
  })
})
