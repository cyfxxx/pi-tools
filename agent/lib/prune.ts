const OUTPUT_BUDGET = 60_000
const PER_TOOL_LIMIT = 15_000

interface OutputEntry {
  tool: string
  length: number
  ts: number
}

let entries: OutputEntry[] = []
let total = 0

export function recordOutput(tool: string, outputLength: number): void {
  entries.push({ tool, length: outputLength, ts: Date.now() })
  total += outputLength
}

export function pruneToolOutput(text: string, toolName: string): string {
  const maxLen = Math.min(PER_TOOL_LIMIT, Math.max(2000, OUTPUT_BUDGET - total))
  if (text.length <= maxLen && total + text.length <= OUTPUT_BUDGET) {
    return text
  }
  const allowed = Math.min(maxLen, Math.max(1000, OUTPUT_BUDGET - total))
  if (allowed <= 0) {
    return `[${toolName} 输出已裁剪：累计输出已达预算上限]`
  }
  const ratio = Math.round((allowed / text.length) * 100)
  const truncated = text.slice(0, allowed)
  return `${truncated}\n\n[${toolName} 输出已截断：${text.length} → ${allowed} 字符 (${ratio}%)]`
}

export function getOutputReport(): string {
  if (entries.length === 0) return ""
  const byTool = new Map<string, number>()
  for (const e of entries) {
    byTool.set(e.tool, (byTool.get(e.tool) || 0) + e.length)
  }
  const lines = [`工具输出预算: ${total.toLocaleString()}/${OUTPUT_BUDGET.toLocaleString()} 字符`]
  for (const [tool, len] of byTool) {
    lines.push(`  ${tool}: ${len.toLocaleString()} 字符`)
  }
  lines.push(`  剩余: ${Math.max(0, OUTPUT_BUDGET - total).toLocaleString()} 字符`)
  return lines.join("\n")
}

export function resetOutputBudget(): void {
  entries = []
  total = 0
}
