/**
 * pi-link guards — 并发保护与去重状态（进程内有效）。
 * 纯模块，不依赖外部 API。
 */

/** T2-4 并发与去重状态（模块级，进程内有效） */
const inflight = new Map<string, boolean>()
const lastSends = new Map<string, { hash: string; ts: number }>()

export const DEDUP_WINDOW_MS = 5 * 60 * 1000

/** 简单字符串 hash（djb2）——去重比对用，无需加密强度 */
export function simpleHash(s: string): string {
  const str = s ?? ''
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 并发/去重校验：同设备 in-flight 拒绝；同设备同消息窗口内拒绝 */
export function checkConcurrentAndDedup(deviceKey: string, message: string): { ok: boolean; detail?: string } {
  if (inflight.get(deviceKey)) {
    return { ok: false, detail: '该设备已有进行中的调用，请等它完成后再发' }
  }
  const hash = simpleHash(message)
  const prev = lastSends.get(deviceKey)
  if (prev && prev.hash === hash && Date.now() - prev.ts < DEDUP_WINDOW_MS) {
    const mins = Math.round((Date.now() - prev.ts) / 60000)
    return { ok: false, detail: `与 ${mins} 分钟前发送的完全相同消息，已去重（如确需重发请稍等或改动内容）` }
  }
  return { ok: true }
}

export function markSendStart(deviceKey: string): void {
  inflight.set(deviceKey, true)
}

/** 发送成功后写去重指纹（审计 MEDIUM：失败/超时不写，避免误拒重发） */
export function markSendSuccess(deviceKey: string, message: string): void {
  lastSends.set(deviceKey, { hash: simpleHash(message), ts: Date.now() })
}

export function markSendEnd(deviceKey: string): void {
  inflight.delete(deviceKey)
}

/** 测试辅助：清空并发/去重状态 */
export function resetSendGuards(): void {
  inflight.clear()
  lastSends.clear()
}
