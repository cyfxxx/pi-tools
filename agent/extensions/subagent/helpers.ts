import * as os from "node:os";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult } from "./types.ts";

// ── Constants ──
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4; // Cloud model batch parallel limit
export const LOCAL_CONCURRENCY = 1; // Local model serial: multiple processes compete for GPU memory

// Environment dimension concurrency limit: Termux/Android resource constrained (mobile memory/battery),
// parallel subagents max 2 to prevent OOM/lag; desktop environments (WSL/Windows/Linux/macOS) not environment limited,
// keep default concurrency (cloud 4 / local 1)
export const TERMUX_MAX_PARALLEL = 2;
export const TERMUX_CONCURRENCY = 2;

export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Chain {previous} injection safety cap (bytes): Linux single argv parameter limit
 * MAX_ARG_STRLEN = 32 pages = 128KB, exceeding causes spawn E2BIG. 96KB for previous,
 * leaving room for task template rest/paths; truncated at end with [truncated] marker. */
export const PREVIOUS_OUTPUT_CAP_BYTES = 96 * 1024;

/**
 * readonly agent allowed tools whitelist (2026-08-28 audit: blacklist mode was bypassed by frontmatter tools -
 * tmux_run/ctx_exec/memory_store etc not in WRITABLE_TOOLS; switched to whitelist fail-closed)
 */
export const READONLY_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** readonly agent forced read-only system prompt (dual insurance with tool filtering) */
export const READONLY_AGENT_HINT = `

---
[强制只读模式] 本代理以只读模式运行：禁止创建、修改、删除任何文件，禁止执行写入性命令与网络上传操作。仅允许使用读取类工具（read/grep/find/ls 等）探索与验证。如需写入操作，在报告中说明需求，由主会话决定。
`;

export const DEFAULT_SYSTEM_PROMPT = `你是通用子代理，在独立上下文中执行委派的任务。

## 工作方式
根据任务类型选择合适策略：
- 探索：用 grep/find 定位相关代码，只读关键部分（不要整文件读），识别类型/接口/关键函数，梳理文件间依赖
- 计划：先收集上下文，再产出具体可执行的步骤
- 执行：小步修改，明确说明每个文件的改动
- 审阅：检查质量、安全、可维护性；bash 仅用于只读命令（git diff/log/show），不得修改文件或运行构建

## 输出要求
你的输出会直接交给主代理（它没有看过你探索过的内容），务必完整：
- 探索任务 → 相关文件（带行号）、关键代码、架构说明、建议从哪开始
- 计划任务 → 目标、编号步骤（具体到文件/函数）、待修改文件、新建文件（如有）、风险
- 执行任务 → 完成情况、修改的文件、备注（如有）
- 审阅任务 → 审阅的文件、必须修复、建议修复、可选改进、总结
- 链式任务 → 若任务基于上一步输出（{previous}），以其为基础继续`;

// ── Environment Detection ──

export function isTermuxEnv(): boolean {
  return process.platform === 'android' || Boolean(process.env.TERMUX_VERSION)
}

export function getMaxParallelTasks(): number {
  return isTermuxEnv() ? TERMUX_MAX_PARALLEL : MAX_PARALLEL_TASKS
}

export function getMaxConcurrency(localProvider: boolean): number {
  if (localProvider) return LOCAL_CONCURRENCY
  return isTermuxEnv() ? TERMUX_CONCURRENCY : MAX_CONCURRENCY
}

// ── Agent Configuration ──

/**
 * readonly agent tool set tightening: whitelist filtering (only read/grep/find/ls); fallback to minimal read-only set when filtered set is empty.
 * Pure function for unit testing (plan-mode only validates agent name, subprocess --no-extensions has no extension interception,
 * read-only isolation must be硬 guaranteed at this layer).
 */
export function resolveAgentTools(agent: { readonly?: boolean; tools?: string[] }): string[] | undefined {
	if (!agent.readonly) return agent.tools;
	const filtered = (agent.tools ?? []).filter((t) => READONLY_ALLOWED_TOOLS.has(t));
	return filtered.length > 0 ? filtered : ["read", "ls"];
}

/** readonly agent system prompt prefix read-only declaration */
export function buildAgentPrompt(agent: { readonly?: boolean; systemPrompt: string }): string {
	return agent.readonly ? READONLY_AGENT_HINT + agent.systemPrompt : agent.systemPrompt;
}

// ── Provider Detection ──

/**
 * Determine if provider is local inference service (ollama/localhost/lmstudio/vllm etc).
 * Local models have limited resources and multiple processes compete for GPU/memory, must be serial; cloud models can batch parallel.
 */
export function isLocalProvider(provider?: string): boolean {
  if (!provider) return false
  const p = provider.toLowerCase()
  return /ollama|localhost|127\.0\.0\.1|\blocal\b|lmstudio|lm\.studio|llama\.cpp|vllm|exo|koboldcpp|text-gen|llamacpp/i.test(p)
}

// ── Process Management ──

/**
 * SIGTERM→SIGKILL kill chain: SIGTERM then delayMs unconditional upgrade to SIGKILL (proc.killed is
 * true after kill() send success, doesn't mean process has exited, can't use it to judge). close event
 * clears upgrade timer. Returns cleanup function.
 */
export function scheduleKillChain(
	proc: { kill: (signal?: NodeJS.Signals | number) => boolean; once?: (ev: string, fn: () => void) => void },
	killDelayMs = 5000,
): () => void {
	try {
		proc.kill("SIGTERM");
	} catch {
		return () => {};
	}
	const killTimer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	}, killDelayMs);
	killTimer.unref?.();
	const clear = () => clearTimeout(killTimer);
	proc.once?.("close", clear);
	return clear;
}

// ── Formatting ──

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// ── Message Processing ──

export function getFinalOutput(messages: Message[]): string {
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

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/**
 * previous output safety cap: truncate by bytes when exceeding PREVIOUS_OUTPUT_CAP_BYTES (keep head),
 * append [truncated] marker. Prevent chain injection of oversized output causing spawn E2BIG silent chain failure.
 */
export function capPreviousOutput(output: string, maxBytes: number = PREVIOUS_OUTPUT_CAP_BYTES): string {
	if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
	let sliced = Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8");
	// Byte boundary may cut multi-byte character (toString produces U+FFFD) - remove trailing partial char
	if (sliced.endsWith("\uFFFD")) sliced = sliced.slice(0, -1);
	return `${sliced}\n[truncated]`;
}

/**
 * Chain task placeholder replacement. Must use function replacement (String.replace string replacement
 * treats $&/$'/$` in previousOutput as replacement patterns causing silent data corruption).
 * Injected previous is capped by capPreviousOutput (audit HIGH: exceeds MAX_ARG_STRLEN(128KB) causes spawn E2BIG).
 */
export function applyPreviousPlaceholder(task: string, previousOutput: string): string {
	return task.replace(/\{previous\}/g, () => capPreviousOutput(previousOutput));
}

/**
 * TUI render fallback: model output may lack task field, empty string fallback + clean {previous} placeholder + preview truncation.
 * Chain/parallel branches share, no exception thrown when field missing.
 */
export function taskPreview(task: string | undefined, maxLen = 40): string {
	const cleanTask = (task ?? "").replace(/\{previous\}/g, "").trim();
	return cleanTask.length > maxLen ? `${cleanTask.slice(0, maxLen)}...` : cleanTask;
}

/** TUI render fallback: show placeholder when agent name missing, prevent render exception */
export function agentLabel(agent: string | undefined): string {
	return agent ?? "?";
}

export function truncateParallelOutput(output: string): string {
	const result = truncateHead(output, { maxBytes: PER_TASK_OUTPUT_CAP });
	if (!result.truncated) return output;
	return `${result.content}\n\n[Output truncated: ${result.totalBytes - result.outputBytes} bytes omitted. Full output preserved in tool details.]`;
}

// ── Task Risk Classification ──

/** Dangerous keywords: hit upgrades to 3σ (high risk, auto-merge prohibited/human confirmation required) */
const HIGH_RISK_RE = /\brm\s+-[rRf]|DROP\s+TABLE|DROP\s+DATABASE|\bmigrate\b|\bbackup\b.*\bdelet|production|prod\b|\bdeploy\b.*\brollback/i
/** Medium risk keywords: hit upgrades to 2σ (medium risk, AI initial review then spot check) */
const MED_RISK_RE = /\bwrite\b|\bedit\b|\bbash\b.*\binstall\b|\bnpm\s+i\b|\bpip\s+install\b|\bchmod\b|\bchown\b|\bsystemctl\b/i

export function classifyTaskRisk(task: string): import("./types.ts").RiskLevel {
  if (HIGH_RISK_RE.test(task)) return "3σ"
  if (MED_RISK_RE.test(task)) return "2σ"
  return "1σ"
}

/** Risk level corresponding tool restrictions: 3σ restricts write operations, 2σ logs */
export function riskToolRestrictions(level: import("./types.ts").RiskLevel): string[] | null {
  if (level === "3σ") return ["read", "grep", "find", "ls"]  // 3σ read-only, require human confirmation to release
  return null // 1σ/2σ no tool restrictions
}

// ── Concurrency Control ──

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number, signal?: AbortSignal) => Promise<TOut>,
	externalSignal?: AbortSignal,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	// Prevent orphan work: when any task fails (e.g., subprocess 30min timeout/external abort throws 'Subagent was aborted')
	// Promise.all immediately rejects, if dispatch loop continues dequeueing it spawns new subprocesses with results无人消费.
	// aborted flag stops worker loop dequeueing; internal controller sends SIGTERM to spawned subprocesses via existing signal→scheduleKillChain chain.
	let aborted = false;
	const internal = new AbortController();
	const stop = () => {
		if (aborted) return;
		aborted = true;
		internal.abort(new Error("Subagent dispatch aborted"));
	};
	const onExternalAbort = () => stop();
	if (externalSignal) {
		if (externalSignal.aborted) stop();
		else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}
	try {
		const workers = new Array(limit).fill(null).map(async () => {
			while (!aborted) {
				const current = nextIndex++;
				if (current >= items.length) return;
				try {
					results[current] = await fn(items[current], current, internal.signal);
				} catch (err) {
					stop();
					throw err;
				}
			}
		});
		await Promise.all(workers);
	} finally {
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
	return results;
}
