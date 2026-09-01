export type ExtensionAPI = Record<string, unknown>
export type ExtensionCommandContext = Record<string, unknown>

/** 简化版 visibleWidth：ASCII=1 列，非 ASCII 按 2 列粗估（测试自洽即可，无需精确东亚宽度表）。 */
export function visibleWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    w += ch.charCodeAt(0) > 0x7f ? 2 : 1
  }
  return w
}

/** 简化版 truncateToWidth：截断字符串至 maxWidth 可视宽度，超宽附加省略号。 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
  if (maxWidth <= 0) return ""
  const eW = visibleWidth(ellipsis)
  if (visibleWidth(text) <= maxWidth) {
    return pad ? text + " ".repeat(maxWidth - visibleWidth(text)) : text
  }
  let cur = ""
  let w = 0
  for (const ch of text) {
    const cw = visibleWidth(ch)
    if (w + cw + eW > maxWidth) break
    cur += ch
    w += cw
  }
  const out = cur + ellipsis
  return pad ? out + " ".repeat(Math.max(0, maxWidth - visibleWidth(out))) : out
}

/** Key 对象 mock，用于快捷键注册 */
export const Key = {
  ctrlAlt: (key: string) => ({ ctrl: true, alt: true, key }),
  ctrl: (key: string) => ({ ctrl: true, key }),
  alt: (key: string) => ({ alt: true, key }),
  shift: (key: string) => ({ shift: true, key }),
  return: { key: 'return' },
  enter: { key: 'enter' },
}