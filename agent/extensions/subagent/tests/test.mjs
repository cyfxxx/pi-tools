// Independent test runner for subagent pure functions.
// Usage: node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs
// Runs without vitest / pi environment.
import assert from "node:assert";

const mod = await import(new URL("../index.ts", import.meta.url).href);

const { formatTokens, formatUsageStats, isFailedResult, getFinalOutput, getResultOutput, truncateParallelOutput, mapWithConcurrencyLimit, isLocalProvider } = mod;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (e) {
		failed++;
		failures.push(`${name}: ${e.message}`);
	}
}

function makeMsg(role, parts) {
	return { role, content: parts, timestamp: 0 };
}
function textPart(t) {
	return { type: "text", text: t };
}
function toolCallPart(name, args) {
	return { type: "toolCall", name, arguments: args };
}

// ---------- formatTokens (9) ----------
test("formatTokens 零 -> 0", () => assert.strictEqual(formatTokens(0), "0"));
test("formatTokens 千以下 -> 原样", () => assert.strictEqual(formatTokens(999), "999"));
test("formatTokens 1k -> 1.0k", () => assert.strictEqual(formatTokens(1000), "1.0k"));
test("formatTokens 1.5k -> 1.5k", () => assert.strictEqual(formatTokens(1500), "1.5k"));
test("formatTokens 9999 -> 10.0k", () => assert.strictEqual(formatTokens(9999), "10.0k"));
test("formatTokens 10k -> 10k", () => assert.strictEqual(formatTokens(10000), "10k"));
test("formatTokens 999k -> 999k", () => assert.strictEqual(formatTokens(999000), "999k"));
test("formatTokens 1M -> 1.0M", () => assert.strictEqual(formatTokens(1000000), "1.0M"));
test("formatTokens 1.5M -> 1.5M", () => assert.strictEqual(formatTokens(1500000), "1.5M"));

// ---------- formatUsageStats (2) ----------
const baseUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
test("formatUsageStats 空 -> 空串", () => assert.strictEqual(formatUsageStats({ ...baseUsage }), ""));
test("formatUsageStats 完整 -> 全字段", () =>
	assert.strictEqual(
		formatUsageStats({
			...baseUsage,
			turns: 2,
			input: 1000,
			output: 2000,
			cacheRead: 3000,
			cacheWrite: 500,
			cost: 0.0123,
			contextTokens: 40000,
		}, "deepseek/deepseek-v4-flash"),
		"2 turns ↑1.0k ↓2.0k R3.0k W500 $0.0123 ctx:40k deepseek/deepseek-v4-flash",
	));

// ---------- isFailedResult (6) ----------
const okResult = { agent: "a", agentSource: "user", task: "t", exitCode: 0, messages: [], stderr: "", usage: baseUsage };
test("isFailedResult exitCode 0 -> false", () => assert.strictEqual(isFailedResult({ ...okResult }), false));
test("isFailedResult exitCode 1 -> true", () => assert.strictEqual(isFailedResult({ ...okResult, exitCode: 1 }), true));
test("isFailedResult exitCode 2 -> true", () => assert.strictEqual(isFailedResult({ ...okResult, exitCode: 2 }), true));
test("isFailedResult stopReason error -> true", () => assert.strictEqual(isFailedResult({ ...okResult, stopReason: "error" }), true));
test("isFailedResult stopReason aborted -> true", () => assert.strictEqual(isFailedResult({ ...okResult, stopReason: "aborted" }), true));
test("isFailedResult stopReason end -> false", () => assert.strictEqual(isFailedResult({ ...okResult, stopReason: "end" }), false));

// ---------- getFinalOutput (4) ----------
test("getFinalOutput 空 -> 空串", () => assert.strictEqual(getFinalOutput([]), ""));
test("getFinalOutput 单条文本 -> 取文本", () =>
	assert.strictEqual(getFinalOutput([makeMsg("assistant", [textPart("hello")])]), "hello"));
test("getFinalOutput 最后一条 assistant 文本 -> 取最后", () =>
	assert.strictEqual(
		getFinalOutput([
			makeMsg("assistant", [textPart("first")]),
			makeMsg("assistant", [textPart("last")]),
		]),
		"last",
	));
test("getFinalOutput 只含 toolCall -> 空串", () =>
	assert.strictEqual(getFinalOutput([makeMsg("assistant", [toolCallPart("read", { file_path: "x" })])]), ""));

// ---------- getResultOutput (5) ----------
test("getResultOutput 成功 -> 最终输出", () =>
	assert.strictEqual(getResultOutput({ ...okResult, messages: [makeMsg("assistant", [textPart("done")])] }), "done"));
test("getResultOutput 成功无输出 -> (no output)", () => assert.strictEqual(getResultOutput(okResult), "(no output)"));
test("getResultOutput 失败 -> errorMessage 优先", () =>
	assert.strictEqual(getResultOutput({ ...okResult, exitCode: 1, errorMessage: "boom" }), "boom"));
test("getResultOutput 失败无 errorMessage -> stderr", () =>
	assert.strictEqual(getResultOutput({ ...okResult, exitCode: 1, stderr: "trace" }), "trace"));
test("getResultOutput 失败全空 -> (no output)", () =>
	assert.strictEqual(getResultOutput({ ...okResult, exitCode: 1 }), "(no output)"));

// ---------- truncateParallelOutput (4) ----------
test("truncateParallelOutput 小文本 -> 不截断", () => {
	const s = "small";
	assert.strictEqual(truncateParallelOutput(s), s);
});
test("truncateParallelOutput 大文本 -> 截断并带标识", () => {
	const big = "x".repeat(60 * 1024);
	const out = truncateParallelOutput(big);
	assert.ok(out.length < big.length, "should be truncated");
	assert.ok(out.includes("Output truncated"), "should include truncation note");
});
test("truncateParallelOutput 正好边界 -> 带标识", () => {
	const big = "x".repeat(52 * 1024);
	const out = truncateParallelOutput(big);
	assert.ok(out.includes("Output truncated"));
});
test("truncateParallelOutput 多字节字符 -> 不炸", () => {
	const big = "中".repeat(30 * 1024);
	const out = truncateParallelOutput(big);
	assert.ok(out.length > 0);
});

// ---------- mapWithConcurrencyLimit (4) ----------
test("mapWithConcurrencyLimit 空输入 -> []", async () => {
	assert.deepStrictEqual(await mapWithConcurrencyLimit([], 2, async (x) => x), []);
});
test("mapWithConcurrencyLimit 全量映射 -> 保序", async () => {
	assert.deepStrictEqual(await mapWithConcurrencyLimit([1, 2, 3], 1, async (x) => x * 2), [2, 4, 6]);
});
test("mapWithConcurrencyLimit 并发控制 -> 峰值不超过 limit", async () => {
	let active = 0;
	let peak = 0;
	await mapWithConcurrencyLimit(
		[1, 2, 3, 4, 5],
		2,
		async (x) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
			return x;
		},
	);
	assert.ok(peak <= 2, `peak ${peak} should be <= 2`);
});

// ---------- isLocalProvider (4) ----------
test("isLocalProvider 本地推理服务判真", () => {
	for (const p of ["ollama", "Ollama", "localhost:11434", "http://127.0.0.1:11434", "lmstudio", "vllm", "koboldcpp"]) {
		assert.strictEqual(isLocalProvider(p), true, `${p} 应为本地`);
	}
});

test("isLocalProvider 云端 provider 判假", () => {
	for (const p of ["deepseek", "openai", "anthropic", "google", "claude", "gemini", undefined]) {
		assert.strictEqual(isLocalProvider(p), false, `${p} 应为云端`);
	}
});

test("isLocalProvider 大小写不敏感", () => {
	assert.strictEqual(isLocalProvider("OLLAMA"), true);
	assert.strictEqual(isLocalProvider("DeepSeek"), false);
});

test("isLocalProvider 边界：local 独立词才命中，子串不误伤", () => {
	// 'local' 需作为独立词（\blocal\b）
	assert.strictEqual(isLocalProvider("local"), true);
	assert.strictEqual(isLocalProvider("mycloud"), false);
	// 'localhost' 子串命中（域名含 localhost 视为本地）
	assert.strictEqual(isLocalProvider("mycloud.localhost.example"), true);
});
test("mapWithConcurrencyLimit 结果保序即使完成顺序乱", async () => {
	const out = await mapWithConcurrencyLimit(
		[1, 2, 3, 4],
		4,
		async (x) => {
			await new Promise((r) => setTimeout(r, (4 - x) * 5));
			return x;
		},
	);
	assert.deepStrictEqual(out, [1, 2, 3, 4]);
});

// ---------- discoverAgents 覆盖顺序（3） ----------
// 用临时目录 + PI_CODING_AGENT_DIR 隔离验证 both 模式下项目级覆盖用户级
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../agents.ts";

function makeAgentDiscoveryFixtures() {
	const base = mkdtempSync(join(tmpdir(), "pi-subagent-agents-"));
	const userAgents = join(base, "agent", "agents");
	const proj = join(base, "proj", ".pi");
	mkdirSync(userAgents, { recursive: true });
	mkdirSync(join(proj, "agents"), { recursive: true });
	const agentMd = (name, desc) =>
		`---\nname: ${name}\ndescription: ${desc}\n---\n\n${desc} 的 system prompt`;
	writeFileSync(join(userAgents, "foo.md"), agentMd("foo", "user-foo"));
	writeFileSync(join(userAgents, "bar.md"), agentMd("bar", "user-bar"));
	writeFileSync(join(proj, "agents", "foo.md"), agentMd("foo", "project-foo"));
	const oldEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(base, "agent");
	const cleanup = () => {
		if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldEnv;
		rmSync(base, { recursive: true, force: true });
	};
	return { cwd: join(base, "proj"), cleanup };
}

test("discoverAgents both 同名 agent 项目级覆盖用户级", () => {
	const { cwd, cleanup } = makeAgentDiscoveryFixtures();
	try {
		const { agents } = discoverAgents(cwd, "both");
		const foo = agents.find((a) => a.name === "foo");
		assert.strictEqual(foo.description, "project-foo", "both 模式下 foo 应来自项目级");
		assert.strictEqual(foo.source, "project");
		assert.strictEqual(agents.length, 2, "bar 仍来自用户级");
	} finally {
		cleanup();
	}
});

test("discoverAgents user 只取用户级", () => {
	const { cwd, cleanup } = makeAgentDiscoveryFixtures();
	try {
		const { agents } = discoverAgents(cwd, "user");
		assert.strictEqual(agents.length, 2);
		assert.ok(agents.every((a) => a.source === "user"));
	} finally {
		cleanup();
	}
});

test("discoverAgents project 只取项目级", () => {
	const { cwd, cleanup } = makeAgentDiscoveryFixtures();
	try {
		const { agents } = discoverAgents(cwd, "project");
		assert.strictEqual(agents.length, 1);
		assert.strictEqual(agents[0].name, "foo");
		assert.strictEqual(agents[0].source, "project");
	} finally {
		cleanup();
	}
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed${failed ? `\n${failures.map((f) => `  ✗ ${f}`).join("\n")}` : ""}`);
if (failed > 0) process.exit(1);
