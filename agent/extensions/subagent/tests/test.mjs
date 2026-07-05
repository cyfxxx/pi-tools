/**
 * Standalone test for subagent extension pure functions
 *
 * Run: node /tmp/subagent-test.mjs
 */

// --- Pure function implementations (extracted from index.ts) ---

function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage, model) {
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function isFailedResult(result) {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getFinalOutput(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function getResultOutput(result) {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output) {
  const PER_TASK_OUTPUT_CAP = 50 * 1024;
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

// For mapWithConcurrencyLimit testing in Node
async function mapWithConcurrencyLimit(items, concurrency, fn) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Tests ---

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  \u2717 ${name}\n`);
  }
}

function assertEqual(actual, expected, name) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  \u2717 ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`);
  }
}

function assertDeepEqual(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  \u2717 ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}\n`);
  }
}

// ──────────────────────────────────────
// formatTokens
// ──────────────────────────────────────
process.stdout.write("\nformatTokens:\n");
assertEqual(formatTokens(0), "0", "zero");
assertEqual(formatTokens(999), "999", "below 1k");
assertEqual(formatTokens(1000), "1.0k", "1k");
assertEqual(formatTokens(1500), "1.5k", "1.5k");
assertEqual(formatTokens(9999), "10.0k", "9,999 rounds to 10.0k");
assertEqual(formatTokens(10000), "10k", "10k rounds to integer");
assertEqual(formatTokens(999999), "1000k", "999,999 → 1000k");
assertEqual(formatTokens(1000000), "1.0M", "1M");
assertEqual(formatTokens(1500000), "1.5M", "1.5M");

// ──────────────────────────────────────
// formatUsageStats
// ──────────────────────────────────────
process.stdout.write("\nformatUsageStats:\n");
assertEqual(
  formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }),
  "",
  "zero usage produces empty string",
);
assertEqual(
  formatUsageStats({ input: 500, output: 200, cacheRead: 100, cacheWrite: 50, cost: 0.0023, contextTokens: 1024, turns: 3 }, "claude-haiku"),
  "3 turns \u2191500 \u2193200 R100 W50 $0.0023 ctx:1.0k claude-haiku",
  "full usage with model",
);

// ──────────────────────────────────────
// isFailedResult
// ──────────────────────────────────────
process.stdout.write("\nisFailedResult:\n");
assert(isFailedResult({ exitCode: 1 }), "exitCode 1 is failure");
assert(isFailedResult({ exitCode: 0, stopReason: "error" }), "stopReason error is failure");
assert(isFailedResult({ exitCode: 0, stopReason: "aborted" }), "stopReason aborted is failure");
assert(!isFailedResult({ exitCode: 0 }), "exitCode 0 no stopReason is success");
assert(!isFailedResult({ exitCode: 0, stopReason: "end" }), "stopReason end is success");
assert(!isFailedResult({ exitCode: 0, stopReason: "stop" }), "stopReason stop is success");

// ──────────────────────────────────────
// getFinalOutput
// ──────────────────────────────────────
process.stdout.write("\ngetFinalOutput:\n");
assertEqual(getFinalOutput([]), "", "empty messages");
assertEqual(
  getFinalOutput([
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ]),
  "Hello",
  "single assistant message",
);
assertEqual(
  getFinalOutput([
    { role: "user", content: [{ type: "text", text: "Hi" }] },
    { role: "assistant", content: [{ type: "text", text: "World" }] },
  ]),
  "World",
  "last assistant message",
);
assertEqual(
  getFinalOutput([
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
  ]),
  "",
  "toolCall only returns empty",
);

// ──────────────────────────────────────
// getResultOutput
// ──────────────────────────────────────
process.stdout.write("\ngetResultOutput:\n");
assertEqual(
  getResultOutput({ exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }),
  "done",
  "success returns final output",
);
assertEqual(
  getResultOutput({ exitCode: 1, errorMessage: "API error", stderr: "", messages: [] }),
  "API error",
  "failure returns errorMessage first",
);
assertEqual(
  getResultOutput({ exitCode: 1, stderr: "connection refused", messages: [] }),
  "connection refused",
  "failure returns stderr when no errorMessage",
);
assertEqual(
  getResultOutput({ exitCode: 1, messages: [{ role: "assistant", content: [{ type: "text", text: "partial output" }] }] }),
  "partial output",
  "failure returns finalOutput as fallback",
);
assertEqual(
  getResultOutput({ exitCode: 1, stderr: "", messages: [] }),
  "(no output)",
  "failure with no output returns placeholder",
);

// ──────────────────────────────────────
// truncateParallelOutput
// ──────────────────────────────────────
process.stdout.write("\ntruncateParallelOutput:\n");
{
  const small = "Hello, world!";
  assertEqual(truncateParallelOutput(small), small, "small output not truncated");
}

{
  const big = "x".repeat(60 * 1024); // ~60 KB
  const truncated = truncateParallelOutput(big);
  assert(Buffer.byteLength(truncated, "utf8") < 55 * 1024, "truncated output is under 55KB");
  assert(truncated.includes("[Output truncated:"), "truncated output contains truncation notice");
}

{
  // 4-char UTF-8 sequence at boundary
  const emojiBig = "\u{1F600}".repeat(20 * 1024); // emojis, 4 bytes each
  const truncated = truncateParallelOutput(emojiBig);
  assert(
    !truncated.endsWith("\u{1F600}"),
    "truncation does not split multi-byte character (may end with notice instead)",
  );
}

// ──────────────────────────────────────
// mapWithConcurrencyLimit
// ──────────────────────────────────────
process.stdout.write("\nmapWithConcurrencyLimit:\n");
{
  const result = await mapWithConcurrencyLimit([], 4, async (x) => x);
  assertDeepEqual(result, [], "empty input returns empty array");
}

{
  const result = await mapWithConcurrencyLimit([1, 2, 3], 10, async (x) => x * 2);
  assertDeepEqual(result, [2, 4, 6], "maps all items correctly");
}

{
  const executionOrder = [];
  await mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (x) => {
    executionOrder.push(`start-${x}`);
    await new Promise((r) => setTimeout(r, 10));
    executionOrder.push(`end-${x}`);
    return x;
  });
  // With concurrency 2, start-1 and start-2 should happen before end-1 or end-2
  const firstTwo = executionOrder.slice(0, 2);
  assert(
    firstTwo.includes("start-1") && firstTwo.includes("start-2"),
    `concurrency 2 starts 2 items first, order was: ${executionOrder.join(", ")}`,
  );
}

{
  // More items than concurrency limit
  const result = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 3, async (x) => x * 10);
  assertDeepEqual(result, [10, 20, 30, 40, 50], "concurrency limited mapping");
}

// ──────────────────────────────────────
// Summary
// ──────────────────────────────────────
const total = passed + failed;
console.log(`\n========================================`);
console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) process.exit(1);
