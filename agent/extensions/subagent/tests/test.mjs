// Independent test runner for subagent pure functions.
// Usage: node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs
// Runs without vitest / pi environment.
import assert from "node:assert";

const mod = await import(new URL("../index.ts", import.meta.url).href);

const { formatTokens, formatUsageStats, isFailedResult, getFinalOutput, getResultOutput, truncateParallelOutput, mapWithConcurrencyLimit, isLocalProvider, applyPreviousPlaceholder, taskPreview, agentLabel } = mod;

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

// ---------- applyPreviousPlaceholder (4) ----------
test("applyPreviousPlaceholder 普通替换", () => {
	assert.strictEqual(applyPreviousPlaceholder("A {previous} B", "out"), "A out B");
});

test("applyPreviousPlaceholder 多占位符全部替换", () => {
	assert.strictEqual(applyPreviousPlaceholder("{previous} + {previous}", "x"), "x + x");
});

test("applyPreviousPlaceholder 输出含 $& 不被当替换模式", () => {
	// String.replace 字符串替换会把 $& 解析为"匹配文本"——函数替换不受影响
	assert.strictEqual(applyPreviousPlaceholder("A {previous} B", "$&"), "A $& B");
});

test("applyPreviousPlaceholder 输出含 $` / $' 不被当替换模式", () => {
	assert.strictEqual(applyPreviousPlaceholder("X {previous} Y", "$`"), "X $` Y");
	assert.strictEqual(applyPreviousPlaceholder("X {previous} Y", "$'"), "X $' Y");
	assert.strictEqual(applyPreviousPlaceholder("X {previous} Y", "$$$"), "X $$$ Y");
});

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

test("mapWithConcurrencyLimit 任务失败后停止出队 + 已运行任务收到 abort 信号", async () => {
	const started = [];
	const sawAbort = [];
	let releaseFirst;
	const firstGate = new Promise((r) => { releaseFirst = r; });
	const p = mapWithConcurrencyLimit(
		[1, 2, 3, 4, 5],
		2,
		async (x, _i, signal) => {
			started.push(x);
			if (x === 1) {
				// 模拟子进程超时/abort 抛错（如 runSubprocessAgent 的 'Subagent was aborted'）
				await firstGate;
				throw new Error("Subagent was aborted");
			}
			// 模拟已 spawn 的子进程：等待 abort 信号（对应 SIGTERM kill 链路）
			await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error("sibling not aborted within 500ms")), 500);
				signal?.addEventListener("abort", () => { clearTimeout(t); sawAbort.push(x); resolve(); }, { once: true });
			});
			return x;
		},
	);
	await new Promise((r) => setTimeout(r, 10)); // 等两个任务启动
	assert.strictEqual(started.length, 2);
	releaseFirst();
	const err = await p.then(() => null, (e) => e);
	assert.ok(err instanceof Error && err.message === "Subagent was aborted", `应拒绝且保留原始错误，实际: ${err}`);
	assert.ok(sawAbort.includes(2), "已运行的 sibling 应收到 abort 信号（SIGTERM 链路）");
	assert.deepStrictEqual([...new Set(started)].sort(), [1, 2], "失败后不得出队新任务（3/4/5 不启动）");
});

test("mapWithConcurrencyLimit 外部 abort -> 停止出队新任务", async () => {
	const ac = new AbortController();
	const started = [];
	const p = mapWithConcurrencyLimit(
		[1, 2, 3],
		1,
		async (x) => {
			started.push(x);
			await new Promise((r) => setTimeout(r, 5));
			return x;
		},
		ac.signal,
	);
	await new Promise((r) => setTimeout(r, 8)); // item1 完成、item2 进行中
	ac.abort();
	await p.then(() => null, () => {});
	assert.ok(!started.includes(3), "外部 abort 后不得继续出队（item1 完成后 item2 被放弃后续）");
	assert.ok(started.includes(1));
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

// ---------- readonly agent 只读隔离（5） ----------
const { resolveAgentTools, buildAgentPrompt, scheduleKillChain } = mod;

test("resolveAgentTools 非 readonly -> 原样返回", () =>
	assert.deepStrictEqual(resolveAgentTools({ tools: ["read", "bash"] }), ["read", "bash"]));
test("resolveAgentTools readonly -> 过滤 bash/edit/write", () =>
	assert.deepStrictEqual(resolveAgentTools({ readonly: true, tools: ["read", "bash", "edit", "write", "ls"] }), ["read", "ls"]));
test("resolveAgentTools readonly 全写入类 -> 回退最小只读集", () =>
	assert.deepStrictEqual(resolveAgentTools({ readonly: true, tools: ["bash"] }), ["read", "ls"]));
test("buildAgentPrompt readonly -> 前置只读声明", () => {
	const out = buildAgentPrompt({ readonly: true, systemPrompt: "BODY" });
	assert.ok(out.startsWith("\n\n---\n[强制只读模式]"));
	assert.ok(out.endsWith("BODY"));
});
test("buildAgentPrompt 非 readonly -> 原样", () =>
	assert.strictEqual(buildAgentPrompt({ systemPrompt: "BODY" }), "BODY"));

test("scheduleKillChain SIGTERM 后升级 SIGKILL", async () => {
	const kills = [];
	const proc = { kill: (s) => { kills.push(s); return true; } };
	scheduleKillChain(proc, 10);
	await new Promise((r) => setTimeout(r, 40));
	assert.deepStrictEqual(kills, ["SIGTERM", "SIGKILL"]);
});

test("scheduleKillChain close 事件清除升级定时器", async () => {
	const kills = [];
	let closeFn;
	const proc = {
		kill: (s) => { kills.push(s); return true; },
		once: (ev, fn) => { if (ev === "close") closeFn = fn; },
	};
	scheduleKillChain(proc, 10);
	closeFn();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepStrictEqual(kills, ["SIGTERM"]);
});

test("scheduleKillChain kill 抛错（已退出）-> 不安排 SIGKILL", async () => {
	const kills = [];
	const proc = { kill: (s) => { kills.push(s); throw new Error("gone"); } };
	scheduleKillChain(proc, 10);
	await new Promise((r) => setTimeout(r, 40));
	assert.deepStrictEqual(kills, ["SIGTERM"]);
});

test("discoverAgents 解析 frontmatter readonly", () => {
	const { cwd, cleanup } = makeAgentDiscoveryFixtures();
	try {
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "agents", "ro.md"),
			"---\nname: ro\ndescription: 只读\nreadonly: true\n---\n\n只读 agent");
		const { agents } = discoverAgents(cwd, "user");
		const ro = agents.find((a) => a.name === "ro");
		assert.strictEqual(ro.readonly, true);
		const bar = agents.find((a) => a.name === "bar");
		assert.strictEqual(bar.readonly, undefined);
	} finally {
		cleanup();
	}
});

// ---------- renderCall 缺 task/agent 守卫 (5) ----------
test("taskPreview 缺 task -> 空串（模型输出缺字段不抛异常）", () =>
	assert.strictEqual(taskPreview(undefined), ""));
test("taskPreview 清理 {previous} 占位", () =>
	assert.strictEqual(taskPreview("总结 {previous} 后继续"), "总结  后继续"));
test("taskPreview 超过 40 字符截断", () =>
	assert.strictEqual(taskPreview("x".repeat(50)), "x".repeat(40) + "..."));
test("agentLabel 缺 agent -> 占位符", () =>
	assert.strictEqual(agentLabel(undefined), "?"));
test("agentLabel 有 agent -> 原样", () =>
	assert.strictEqual(agentLabel("scout"), "scout"));

// ---------- 环境并发限制（Termux ≤2 / 桌面默认） (4) ----------
test("桌面环境默认并行任务上限 8", () => {
	const { getMaxParallelTasks, isTermuxEnv } = mod;
	if (isTermuxEnv()) return; // Termux 实机上跳过（本用例只验证桌面默认）
	assert.strictEqual(getMaxParallelTasks(), 8);
});

test("桌面环境云端并发 4 / 本地并发 1", () => {
	const { getMaxConcurrency, isTermuxEnv } = mod;
	if (isTermuxEnv()) return;
	assert.strictEqual(getMaxConcurrency(false), 4);
	assert.strictEqual(getMaxConcurrency(true), 1);
});

test("Termux 环境任务上限 2 / 并发 2", () => {
	const { getMaxParallelTasks, getMaxConcurrency, isTermuxEnv } = mod;
	const savedPlatform = process.platform;
	const savedTermux = process.env.TERMUX_VERSION;
	Object.defineProperty(process, 'platform', { value: 'android' });
	process.env.TERMUX_VERSION = '0.118';
	assert.strictEqual(isTermuxEnv(), true);
	assert.strictEqual(getMaxParallelTasks(), 2);
	assert.strictEqual(getMaxConcurrency(false), 2);
	assert.strictEqual(getMaxConcurrency(true), 1); // 本地模型仍串行
	delete process.env.TERMUX_VERSION;
	Object.defineProperty(process, 'platform', { value: savedPlatform });
	if (savedTermux !== undefined) process.env.TERMUX_VERSION = savedTermux;
});

test("TERMUX_VERSION 变量单独生效（WSL 内跑 Termux 场景）", () => {
	const { isTermuxEnv, getMaxConcurrency } = mod;
	const saved = process.env.TERMUX_VERSION;
	process.env.TERMUX_VERSION = '0.118';
	assert.strictEqual(isTermuxEnv(), true);
	assert.strictEqual(getMaxConcurrency(false), 2);
	delete process.env.TERMUX_VERSION;
	if (saved !== undefined) process.env.TERMUX_VERSION = saved;
});

// ---------- summary ----------
console.log(`\n${passed} passed, ${failed} failed${failed ? `\n${failures.map((f) => `  ✗ ${f}`).join("\n")}` : ""}`);
if (failed > 0) process.exit(1);
