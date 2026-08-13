import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { touchActive, isActive, readActive, selfName, ACTIVE_WINDOW_MS, activeFilePath, isUnattendedEnv } from '../active'
import { parseState } from '../state'

// os.tmpdir()：Linux=/tmp，Termux=$PREFIX/tmp（无 /tmp 目录）
const TMP = join(tmpdir(), 'pi-link-test-active')

describe('pi-link: active 活跃机制 (T2-1)', () => {
  beforeEach(() => {
    process.env.PI_LINK_STATE_DIR = TMP
  })
  afterEach(() => {
    delete process.env.PI_LINK_STATE_DIR
  })

  it('selfName 优先配置名，缺省 hostname', () => {
    expect(selfName('phone')).toBe('phone')
    expect(selfName()).toBe(require('node:os').hostname())
  })

  it('touchActive 后 isActive 为真；未 touch 为假', () => {
    touchActive('phone', '测试输入')
    const st = readActive()
    expect(st?.device).toBe('phone')
    expect(st?.lastInput).toContain('测试输入')
    expect(isActive(st)).toBe(true)
  })

  it('PI_UNATTENDED 环境标记', () => {
    expect(isUnattendedEnv()).toBe(false)
    process.env.PI_UNATTENDED = '1'
    expect(isUnattendedEnv()).toBe(true)
    delete process.env.PI_UNATTENDED
  })

  it('超时窗口后不活跃', () => {
    const old = Date.now() - ACTIVE_WINDOW_MS - 1000
    touchActive('phone', 'x')
    // 伪造旧时间戳
    const { writeFileSync } = require('node:fs')
    writeFileSync(activeFilePath(), JSON.stringify({ device: 'phone', lastActiveAt: old }), 'utf-8')
    expect(isActive(readActive())).toBe(false)
  })
})

describe('pi-link: 远程状态解析 (T2-2)', () => {
  it('解析合法状态', () => {
    const st = parseState(JSON.stringify({
      device: 'remote', status: 'busy', currentTask: '编译', tmuxSession: 'pi-main', updatedAt: 123,
    }))
    expect(st?.status).toBe('busy')
    expect(st?.currentTask).toBe('编译')
    expect(st?.tmuxSession).toBe('pi-main')
  })
  it('非法状态返回 null', () => {
    expect(parseState('not json')).toBeNull()
    expect(parseState(JSON.stringify({ status: 'weird' }))).toBeNull()
  })
})

describe('pi-link: index 注册面（input/turn_start/agent_settled 监听）', () => {
  it('注册活跃与状态事件监听', async () => {
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerFlag: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      setActiveTools: vi.fn(),
      getFlag: vi.fn(() => false),
    }
    const main = (await import('../index')).default
    main(pi as never)
    const events = pi.on.mock.calls.map((c: string[]) => c[0])
    expect(events).toContain('input')
    expect(events).toContain('turn_start')
    expect(events).toContain('agent_settled')
  })
})
