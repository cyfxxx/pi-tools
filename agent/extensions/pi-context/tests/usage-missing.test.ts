import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 审计 M6 探针回归（2026-08-25）：turn_end 缺 usage 时 recordUsageMissing 落一条
// usage-missing 事件且 10 分钟节流——确认「provider 缺流式 usage」假设的真实触发面
let diagFile: string

beforeEach(() => {
  diagFile = join(mkdtempSync(join(tmpdir(), 'pi-diag-test-')), 'diag.jsonl')
  process.env.PI_USAGE_DIAG_FILE = diagFile
  vi.resetModules()
})

afterEach(() => {
  delete process.env.PI_USAGE_DIAG_FILE
  rmSync(diagFile, { force: true })
  rmSync(join(diagFile, '..'), { recursive: true, force: true })
})

describe('usage-missing 探针', () => {
  it('连续触发只落一条事件（节流生效）', async () => {
    const { recordUsageMissing } = await import('../../../lib/usage-diag.ts')
    recordUsageMissing()
    recordUsageMissing()
    recordUsageMissing()
    const lines = readFileSync(diagFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const evt = JSON.parse(lines[0])
    expect(evt.type).toBe('usage-missing')
    expect(typeof evt.ts).toBe('number')
  })

  it('文件写入失败不抛错（诊断不阻塞会话）', async () => {
    process.env.PI_USAGE_DIAG_FILE = '/proc/nonexistent-dir/diag.jsonl'
    vi.resetModules()
    const { recordUsageMissing } = await import('../../../lib/usage-diag.ts')
    expect(() => recordUsageMissing()).not.toThrow()
  })
})
