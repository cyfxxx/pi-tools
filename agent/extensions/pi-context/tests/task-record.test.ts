import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordTaskRecord, loadTaskRecords, type TaskRecord } from '../../../lib/task-record.ts'

let dir: string
const ORIG = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-record-'))
  process.env.PI_TASK_RECORD_FILE = join(dir, 'records.jsonl')
  delete process.env.PI_DISABLE_TASK_RECORD
})

afterEach(() => {
  process.env = { ...ORIG }
  delete process.env.PI_TASK_RECORD_FILE
  rmSync(dir, { recursive: true, force: true })
})

describe('task-record', () => {
  it('record 后 load 可读回完整字段', () => {
    recordTaskRecord({
      userRequest: '检查一下调整思考档位后的缓存命中变化',
      contextTokens: 120_000,
      cacheHit: 100_000,
      output: 3000,
      tools: 8,
      compacted: false,
      levelChanged: true,
      userSeq: 5,
    })
    const recs: TaskRecord[] = loadTaskRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0].userRequest).toContain('缓存命中')
    expect(recs[0].tools).toBe(8)
    expect(recs[0].levelChanged).toBe(true)
    expect(recs[0].compacted).toBe(false)
  })

  it('多条按序写入', () => {
    recordTaskRecord({ userRequest: 'a', contextTokens: 0, cacheHit: 0, output: 0, tools: 0, compacted: false, levelChanged: false, userSeq: 1 })
    recordTaskRecord({ userRequest: 'b', contextTokens: 100, cacheHit: 0, output: 0, tools: 1, compacted: true, levelChanged: false, userSeq: 2 })
    expect(loadTaskRecords().map((r) => r.userRequest)).toEqual(['a', 'b'])
  })

  it('PI_DISABLE_TASK_RECORD=1 时跳过（后台总结 pi 防递归）', () => {
    process.env.PI_DISABLE_TASK_RECORD = '1'
    recordTaskRecord({ userRequest: 'x', contextTokens: 0, cacheHit: 0, output: 0, tools: 0, compacted: false, levelChanged: false, userSeq: 1 })
    expect(loadTaskRecords()).toHaveLength(0)
  })

  it('无文件时 load 返回空数组', () => {
    expect(loadTaskRecords()).toEqual([])
  })
})
