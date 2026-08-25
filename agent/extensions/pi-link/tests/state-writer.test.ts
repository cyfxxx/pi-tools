import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeLocalState, localStateFilePath, type LocalState } from '../state-writer.ts'

let dir: string

const readState = (): Partial<LocalState> => JSON.parse(readFileSync(localStateFilePath(), 'utf-8'))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-link-state-'))
  process.env.PI_LINK_STATE_DIR = dir
})

afterEach(() => {
  delete process.env.PI_LINK_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

// 审计：idle 回写不清 currentTask 致陈旧任务名一直展示（远程 watch/attach 看到
// 早已结束的任务）。partial 无 currentTask 且状态为 idle 时显式置 undefined。
describe('pi-link state-writer: idle 清除 currentTask', () => {
  it('idle 回写无 currentTask 时清掉陈旧值（回归：修复前一直残留）', () => {
    writeLocalState({ device: 'me', status: 'busy', currentTask: '编译内核' })
    expect(readState().currentTask).toBe('编译内核')
    writeLocalState({ device: 'me', status: 'idle' })
    const s = readState()
    expect(s.status).toBe('idle')
    expect(s.currentTask).toBeUndefined()
    // 显式置 undefined → JSON 序列化时省略该键
    expect('currentTask' in s).toBe(false)
  })

  it('busy 回写无 currentTask 时保留旧任务名（同一任务运行中，语义不变）', () => {
    writeLocalState({ device: 'me', status: 'busy', currentTask: '跑测试' })
    writeLocalState({ device: 'me', status: 'busy' })
    const s = readState()
    expect(s.status).toBe('busy')
    expect(s.currentTask).toBe('跑测试')
  })

  it('idle 回写显式带 currentTask 时尊重传入值；其余字段照常合并', () => {
    writeLocalState({ device: 'me', status: 'busy', tmuxSession: '0' })
    writeLocalState({ status: 'idle', currentTask: '收尾清理' })
    const s = readState()
    expect(s.currentTask).toBe('收尾清理')
    expect(s.device).toBe('me')
    expect(s.tmuxSession).toBe('0')
  })

  it('首次写入（无旧文件）idle 无 currentTask 不报错', () => {
    writeLocalState({ device: 'fresh', status: 'idle' })
    const s = readState()
    expect(s.device).toBe('fresh')
    expect(s.status).toBe('idle')
    expect('currentTask' in s).toBe(false)
  })
})
