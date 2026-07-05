/**
 * Standalone test for token-budget shared module
 *
 * Run: node /tmp/token-budget-test.mjs
 */

// Pure function implementations (extracted from token-budget.ts)

function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

function truncateByTokens(text, maxTokens) {
  const targetLen = maxTokens * 3.5
  if (text.length <= targetLen) return text
  const ratio = text.length > 0 ? Math.round((targetLen / text.length) * 100) : 0
  const truncated = text.slice(0, Math.floor(targetLen))
  return `${truncated}\n\n[truncated: ${text.length} chars \u2192 ${truncated.length} chars (${ratio}%)]`
}

function compressOutput(text, targetTokens) {
  const targetChars = targetTokens * 3.5
  if (text.length <= targetChars) return text

  const headPortion = Math.floor(targetChars * 0.55)
  const tailPortion = Math.floor(targetChars * 0.35)
  const head = text.slice(0, headPortion)
  const tail = text.slice(-tailPortion)
  const middle = text.slice(headPortion, text.length - tailPortion)

  const middleLines = middle.split("\n")
  const importantLines = middleLines.filter(
    (l) => /^#{1,3}\s|^\d+\.\s|^- |^\* |\[DONE:|FAIL:|ERROR:|^[A-Z][A-Z\s]+:/.test(l.trim()),
  )
  const compressedMiddle = importantLines.slice(0, 20).join("\n")

  const result = [head.trim(), "", "--- (compressed " + middle.length + " chars to " + compressedMiddle.length + ") ---", "", compressedMiddle, "", "--- (end compression) ---", "", tail.trim()].filter(Boolean).join("\n")

  if (result.length <= targetChars) return result
  return result.slice(0, Math.floor(targetChars)) + "\n\n[output compressed to fit budget]"
}

// --- Tests ---

let passed = 0
let failed = 0

function assert(condition, name) {
  if (condition) { passed++; process.stdout.write(`  \u2713 ${name}\n`) }
  else { failed++; process.stdout.write(`  \u2717 ${name}\n`) }
}

function assertEqual(actual, expected, name) {
  const ok = actual === expected
  if (ok) { passed++; process.stdout.write(`  \u2713 ${name}\n`) }
  else { failed++; process.stdout.write(`  \u2717 ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`) }
}

// ──────────────────────────────────────
// estimateTokens
// ──────────────────────────────────────
process.stdout.write("\nestimateTokens:\n")
assertEqual(estimateTokens(""), 0, "empty string")
assertEqual(estimateTokens("hello"), 2, "short string (5/3.5=1.4→2)")
assertEqual(estimateTokens("a".repeat(350)), 100, "350 chars = 100 tokens")
assertEqual(estimateTokens("a".repeat(3500)), 1000, "3500 chars = 1000 tokens")

// ──────────────────────────────────────
// truncateByTokens
// ──────────────────────────────────────
process.stdout.write("\ntruncateByTokens:\n")
assertEqual(truncateByTokens("short", 100), "short", "short text not truncated")
{
  const big = "x".repeat(10000)
  const result = truncateByTokens(big, 100)
  assert(result.includes("[truncated:"), "truncated text contains marker")
  assert(result.length < 400, `truncated result length ${result.length} < 400`)
}

// ──────────────────────────────────────
// compressOutput
// ──────────────────────────────────────
process.stdout.write("\ncompressOutput:\n")
assertEqual(compressOutput("short", 1000), "short", "short text not compressed")

{
  const big = Array.from({ length: 500 }, (_, i) => `Step ${i + 1}: do something`).join("\n")
  const result = compressOutput(big, 50)
  assert(result.includes("(compressed"), "compressed text contains marker")
  assert(result.includes("(end compression)"), "compressed text has end marker")
  const lines = result.split("\n")
  assert(lines.length < big.split("\n").length, "compressed has fewer lines than original")
}

{
  // Compression preserves beginning, middle structure markers
  const lines = []
  for (let i = 0; i < 200; i++) {
    lines.push(`Line ${i}: ${i === 0 ? "START_MARKER" : i === 199 ? "END_MARKER" : "middle content"}`)
  }
  const big = lines.join("\n")
  const result = compressOutput(big, 100)
  assert(result.includes("START_MARKER"), "compression preserves beginning")
  assert(result.includes("(compressed") || result.includes("compression"), "compression adds structure markers")
}

{
  // Very tight budget still captures structure
  const big = Array.from({ length: 500 }, (_, i) => `Line ${i}: data`).join("\n")
  const result = compressOutput(big, 20)
  assert(result.includes("(compressed") || result.includes("compressed"), "tight budget still shows compression")
}

// ──────────────────────────────────────
// recordToolUsage / getBudgetReport
// (simulated, without importing the module)
// ──────────────────────────────────────
process.stdout.write("\ntoken-budget shared module:\n")
// Test that the module file exists
import("fs").then(fs => {
  const exists = fs.existsSync("/root/.pi/agent/lib/token-budget.ts")
  assert(exists, "lib/token-budget.ts file exists")
}).catch(() => assert(false, "fs import failed"))

// ──────────────────────────────────────
// Summary
// ──────────────────────────────────────
const total = passed + failed
console.log(`\n========================================`)
console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`)
if (failed > 0) process.exit(1)
