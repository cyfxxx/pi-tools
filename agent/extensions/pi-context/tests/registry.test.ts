import { describe, it, expect } from 'vitest'
import { createRegistry, composeDisposers } from '../../../lib/registry.ts'

describe('registry: 登记/清理（dsh effect 借鉴）', () => {
  it('register 返回 disposer，dispose 后条目消失', () => {
    const r = createRegistry<string>()
    const d1 = r.register('a', 'v1')
    expect(r.get('a')).toBe('v1')
    d1()
    expect(r.has('a')).toBe(false)
  })

  it('同 key 后注册覆盖先注册，旧 disposer 不误删新条目', () => {
    const r = createRegistry<string>()
    const d1 = r.register('a', 'v1')
    const d2 = r.register('a', 'v2')
    expect(r.get('a')).toBe('v2')
    d1() // 旧 disposer：不应删除新条目
    expect(r.get('a')).toBe('v2')
    d2()
    expect(r.has('a')).toBe(false)
  })

  it('dispose 幂等（多次调用无害）', () => {
    const r = createRegistry<string>()
    const d = r.register('a', 'v')
    d()
    d()
    expect(r.has('a')).toBe(false)
  })

  it('entries 按注册序返回，size 正确', () => {
    const r = createRegistry<string>()
    r.register('a', '1')
    r.register('b', '2')
    expect(r.entries().map(e => e.key)).toEqual(['a', 'b'])
    expect(r.size).toBe(2)
    r.remove('a')
    expect(r.size).toBe(1)
    r.clear()
    expect(r.size).toBe(0)
  })

  it('initial 初始化', () => {
    const r = createRegistry<string>({ x: '1', y: '2' })
    expect(r.size).toBe(2)
    expect(r.get('y')).toBe('2')
  })
})

describe('composeDisposers: 逆序清理链', () => {
  it('按注册逆序执行（后注册先清理）', () => {
    const order: string[] = []
    const composed = composeDisposers(
      () => order.push('first'),
      () => order.push('second'),
      () => order.push('third'),
    )
    composed()
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('单个 disposer 抛错不阻断其余', () => {
    const order: string[] = []
    const composed = composeDisposers(
      () => order.push('a'),
      () => { throw new Error('boom') },
      () => order.push('c'),
    )
    expect(() => composed()).not.toThrow()
    expect(order).toEqual(['c', 'a'])
  })
})
