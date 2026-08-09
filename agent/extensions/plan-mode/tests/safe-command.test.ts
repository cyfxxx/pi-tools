import { describe, it, expect } from 'vitest'
import { isSafeCommand } from '../utils.ts'

describe('isSafeCommand 复合命令解析（③放宽）', () => {
  it('允许 cd && 单条白名单命令', () => {
    expect(isSafeCommand('cd /tmp && ls')).toBe(true)
    expect(isSafeCommand('cd /tmp && git log --oneline')).toBe(true)
    expect(isSafeCommand('cd "$HOME/repo" && git status')).toBe(true)
  })

  it('允许尾部 2>/dev/null', () => {
    expect(isSafeCommand('ls 2>/dev/null')).toBe(true)
    expect(isSafeCommand('cd /tmp && grep x file 2>/dev/null')).toBe(true)
  })

  it('保持拒绝: 分号/管道/多重 &&', () => {
    expect(isSafeCommand('ls; rm b')).toBe(false)
    expect(isSafeCommand('ls | grep x')).toBe(false)
    expect(isSafeCommand('cd /tmp && ls; rm b')).toBe(false)
    expect(isSafeCommand('cd /tmp && cd /root && ls')).toBe(false)
  })

  it('保持拒绝: 写与重定向', () => {
    expect(isSafeCommand('echo hi > out.txt')).toBe(false)
    expect(isSafeCommand('ls 2>err.log')).toBe(false)
    expect(isSafeCommand('ls 2>&1')).toBe(false)
    expect(isSafeCommand('cat a 2>/dev/null > out')).toBe(false)
    expect(isSafeCommand('rm -rf /tmp/x 2>/dev/null')).toBe(false)
  })

  it('保持拒绝: 破坏性命令与 git clone', () => {
    expect(isSafeCommand('git clone https://x')).toBe(false)
    expect(isSafeCommand('cd /tmp && git clone https://x')).toBe(false)
    expect(isSafeCommand('curl -o out https://x')).toBe(false)
  })

  it('白名单命令整体匹配核心（cd 前缀剥离后）', () => {
    expect(isSafeCommand('cd /tmp && git ls-remote https://github.com/a/b.git')).toBe(true)
    expect(isSafeCommand('cd /tmp && curl -s https://api.github.com/repos/a/b')).toBe(true)
  })
})