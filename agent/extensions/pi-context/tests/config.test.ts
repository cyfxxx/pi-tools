import { describe, it, expect, afterAll } from 'vitest'
import { mergeLayers, loadUserConfig } from '../../../lib/config.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('config: mergeLayers 多层深合并', () => {
  it('对象递归合并，后层覆盖前层', () => {
    const r = mergeLayers(
      { a: 1, b: { x: 1, y: 2 } },
      { b: { y: 3, z: 4 } },
    )
    expect(r).toEqual({ a: 1, b: { x: 1, y: 3, z: 4 } })
  })

  it('数组整体替换（非合并，对齐 dsh patch 整行语义）', () => {
    const r = mergeLayers(
      { list: [1, 2, 3] },
      { list: [9] },
    )
    expect(r).toEqual({ list: [9] })
  })

  it('标量整体替换', () => {
    const r = mergeLayers({ n: 1, s: 'a' }, { n: 2 })
    expect(r).toEqual({ n: 2, s: 'a' })
  })

  it('忽略 undefined/null 层', () => {
    const r = mergeLayers({ a: 1 }, undefined, null, { b: 2 })
    expect(r).toEqual({ a: 1, b: 2 })
  })
})

describe('config: loadUserConfig 用户配置读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-test-'))
  const path = join(dir, 'user.json')

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('文件缺失：返回默认副本 + loaded=false', () => {
    const { config, loaded } = loadUserConfig(join(dir, 'nope.json'), { a: 1, b: { x: 1 } })
    expect(loaded).toBe(false)
    expect(config).toEqual({ a: 1, b: { x: 1 } })
  })

  it('文件存在：默认与用户深合并', () => {
    writeFileSync(path, JSON.stringify({ b: { y: 2 } }))
    const { config, loaded } = loadUserConfig(path, { a: 1, b: { x: 1 } })
    expect(loaded).toBe(true)
    expect(config).toEqual({ a: 1, b: { x: 1, y: 2 } })
  })

  it('返回的默认副本不污染原始 defaults（防共享引用）', () => {
    const defaults = { a: { x: 1 } }
    const { config } = loadUserConfig(join(dir, 'nope.json'), defaults)
    ;(config as { a: { x: number } }).a.x = 999
    expect(defaults.a.x).toBe(1)
  })

  it('损坏 JSON：回退默认 + 返回 error 不抛错', () => {
    writeFileSync(join(dir, 'bad.json'), '{invalid')
    const { config, loaded, error } = loadUserConfig(join(dir, 'bad.json'), { a: 1 })
    expect(loaded).toBe(false)
    expect(config).toEqual({ a: 1 })
    expect(error).toBeTruthy()
  })
})
