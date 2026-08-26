import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveOutput, archivedStub } from '../../../lib/output-archive.ts'
import { pruneToolOutput } from '../../../lib/context-budget.ts'

// 归档目录指向临时目录，避免污染真实 ~/.pi/logs/tool-outputs（必须在首个用例前生效）
const tmp = mkdtempSync(join(tmpdir(), 'ov-archive-'))
process.env.PI_OUTPUT_ARCHIVE_DIR = tmp

beforeAll(() => { process.env.PI_OUTPUT_ARCHIVE_DIR = tmp })
afterAll(() => {
  delete process.env.PI_OUTPUT_ARCHIVE_DIR
  rmSync(tmp, { recursive: true, force: true })
})

describe('output-archive 工具输出归档（借鉴 OpenViking 外置化）', () => {
  it('归档返回路径且文件内容与原文一致', () => {
    const text = 'A'.repeat(5000)
    const path = archiveOutput(text)
    expect(path).toBeTruthy()
    expect(readFileSync(path!, 'utf-8')).toBe(text)
  })

  it('同内容重复归档 → 同路径（确定性，缓存友好）', () => {
    const text = 'B'.repeat(3000)
    const p1 = archiveOutput(text)
    const p2 = archiveOutput(text)
    expect(p1).toBe(p2)
  })

  it('不同内容 → 不同路径', () => {
    const a = archiveOutput('content-alpha-'.repeat(200))
    const b = archiveOutput('content-beta-'.repeat(200))
    expect(a).not.toBe(b)
  })

  it('空文本返回 null', () => {
    expect(archiveOutput('')).toBeNull()
  })

  it('写盘失败 fail-open 返回 null（目录不可写）', () => {
    const prev = process.env.PI_OUTPUT_ARCHIVE_DIR
    // /dev/null 下建子目录必然失败
    process.env.PI_OUTPUT_ARCHIVE_DIR = '/dev/null/ov-impossible'
    const r = archiveOutput('x'.repeat(100))
    process.env.PI_OUTPUT_ARCHIVE_DIR = prev
    expect(r).toBeNull()
  })

  it('archivedStub 附存档路径；归档失败退化为纯说明', () => {
    const stub = archivedStub('y'.repeat(2000), '[t 输出已截断]')
    expect(stub).toContain('[t 输出已截断]')
    expect(stub).toMatch(/已存档: .+\.txt$/)
    const prev = process.env.PI_OUTPUT_ARCHIVE_DIR
    process.env.PI_OUTPUT_ARCHIVE_DIR = '/dev/null/ov-impossible'
    const fallback = archivedStub('z'.repeat(2000), '[t 输出已裁剪]')
    process.env.PI_OUTPUT_ARCHIVE_DIR = prev
    expect(fallback).toBe('[t 输出已裁剪]')
    expect(existsSync(stub.match(/已存档: (.+\.txt)/)![1])).toBe(true)
  })

  it('pruneToolOutput 截断时占位符附存档路径（集成）', () => {
    const big = 'w'.repeat(60_000) // 远超单工具 5K token 预算
    const out = pruneToolOutput(big, 'bash')
    expect(out).toContain('输出已截断')
    expect(out).toMatch(/原文 \d+ 字符已存档: (.+\.txt)$/)
    const m = out.match(/已存档: (.+\.txt)$/)!
    expect(readFileSync(m[1], 'utf-8')).toBe(big)
  })

  it('pruneToolResults 擦除侧归档由 dumpRef 回调承接（与 b798152 refs 机制对接）', async () => {
    // 分层擦除的可恢复机制由远端 dumpRef 回调承担（pi-context index.ts buildPruneDumpRef）；
    // 此处验证 output-archive 的确定性落盘函数可作为任意 dumpRef 实现使用
    const text = 'DUMP-REF-PAYLOAD '.repeat(500)
    const path = archiveOutput(text)
    expect(path).toBeTruthy()
    expect(readFileSync(path!, 'utf-8')).toBe(text)
  })
})
