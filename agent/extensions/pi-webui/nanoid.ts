/**
 * 简易 nanoid 实现 (无需外部依赖)
 * 生成 URL-safe 的短唯一 ID
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const SIZE = 21

export function nanoid(size = SIZE): string {
  let id = ''
  const bytes = new Uint8Array(size)
  // 使用 crypto.getRandomValues 如果可用，否则用 Math.random
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  for (let i = 0; i < size; i++) {
    id += CHARS[bytes[i] % CHARS.length]
  }
  return id
}
