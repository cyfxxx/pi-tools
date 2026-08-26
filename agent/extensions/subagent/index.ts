/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	calculateContextTokens,
	type ExtensionAPI,
	getMarkdownTheme,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4; // 云端模型批量并行上限
const LOCAL_CONCURRENCY = 1; // 本地模型串行：多进程会竞争 GPU 内存

// 环境维度并发限制：Termux/Android 资源受限（移动端内存/电池），并行子代理
// 最多 2 个防 OOM/卡顿；桌面环境（WSL/Windows/Linux/macOS）不受环境限制，
// 保持默认并发（云端 4 / 本地 1）
const TERMUX_MAX_PARALLEL = 2;
const TERMUX_CONCURRENCY = 2;

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

/** 写入类工具：readonly agent spawn 时强制移除（只读隔离的硬约束） */
const WRITABLE_TOOLS = new Set(["bash", "edit", "write"]);

/** readonly agent 的强制只读系统提示（与工具过滤双保险） */
const READONLY_AGENT_HINT = `

---
[强制只读模式] 本代理以只读模式运行：禁止创建、修改、删除任何文件，禁止执行写入性命令与网络上传操作。仅允许使用读取类工具（read/grep/find/ls 等）探索与验证。如需写入操作，在报告中说明需求，由主会话决定。
`;

/**
 * readonly agent 的工具集收紧：过滤写入类工具；过滤后为空时回退最小只读集。
 * 纯函数便于单测（plan-mode 只校验 agent 名，子进程 --no-extensions 无扩展拦截，
 * 只读隔离必须在此层硬保证）。
 */
export function resolveAgentTools(agent: { readonly?: boolean; tools?: string[] }): string[] | undefined {
	if (!agent.readonly) return agent.tools;
	const filtered = (agent.tools ?? []).filter((t) => !WRITABLE_TOOLS.has(t));
	return filtered.length > 0 ? filtered : ["read", "ls"];
}

/** readonly agent 的系统提示前置只读声明 */
export function buildAgentPrompt(agent: { readonly?: boolean; systemPrompt: string }): string {
	return agent.readonly ? READONLY_AGENT_HINT + agent.systemPrompt : agent.systemPrompt;
}

/**
 * SIGTERM→SIGKILL 终止链：SIGTERM 后 delayMs 无条件升级 SIGKILL（proc.killed 在
 * kill() 发送成功后即为 true，不代表进程已退出，不能用它判断）。close 事件
 * 清除升级定时器。返回清理函数。
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
			/* 已退出 */
		}
	}, killDelayMs);
	killTimer.unref?.();
	const clear = () => clearTimeout(killTimer);
	proc.once?.("close", clear);
	return clear;
}

/**
 * 判断 provider 是否为本地推理服务（ollama/localhost/lmstudio/vllm 等）。
 * 本地模型资源有限且多进程会争抢 GPU/内存，须串行；云端模型可批量并行。
 */
export function isLocalProvider(provider?: string): boolean {
  if (!provider) return false
  const p = provider.toLowerCase()
  return /ollama|localhost|127\.0\.0\.1|\blocal\b|lmstudio|lm\.studio|llama\.cpp|vllm|exo|koboldcpp|text-gen|llamacpp/i.test(p)
}
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** 链式 {previous} 注入安全上限（字节）：Linux 单个 argv 参数上限
 * MAX_ARG_STRLEN = 32 页 = 128KB，超限时 spawn 抛 E2BIG。96KB 为 previous 预留，
 * 给任务模板其余部分/路径等留余量；超出尾部截断并附 [truncated] 标记。 */
const PREVIOUS_OUTPUT_CAP_BYTES = 96 * 1024;

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

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

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
 * previous 输出安全上限：超 PREVIOUS_OUTPUT_CAP_BYTES 时按字节截断（保留头部），
 * 附 [truncated] 标记。防止链式注入超大输出导致 spawn E2BIG 整链静默失败。
 */
export function capPreviousOutput(output: string, maxBytes: number = PREVIOUS_OUTPUT_CAP_BYTES): string {
	if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
	let sliced = Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8");
	// 字节边界可能切断多字节字符（toString 产生 U+FFFD）——去掉残字符
	if (sliced.endsWith("\uFFFD")) sliced = sliced.slice(0, -1);
	return `${sliced}\n[truncated]`;
}

/**
 * 链式任务占位符替换。必须用函数替换（String.replace 字符串替换会把
 * previousOutput 中的 $&/$'/$` 当作替换模式导致静默数据损坏）。
 * 注入的 previous 经 capPreviousOutput 封顶（审计 HIGH：无截断时超过
 * MAX_ARG_STRLEN(128KB) 即 spawn E2BIG）。
 */
export function applyPreviousPlaceholder(task: string, previousOutput: string): string {
	return task.replace(/\{previous\}/g, () => capPreviousOutput(previousOutput));
}

/**
 * TUI 渲染兜底：模型输出可能缺 task 字段，空串兜底 + 清理 {previous} 占位 + 预览截断。
 * 链/并行分支共用，缺字段时不再抛异常。
 */
export function taskPreview(task: string | undefined, maxLen = 40): string {
	const cleanTask = (task ?? "").replace(/\{previous\}/g, "").trim();
	return cleanTask.length > maxLen ? `${cleanTask.slice(0, maxLen)}...` : cleanTask;
}

/** TUI 渲染兜底：缺 agent 名时显示占位符，防渲染抛异常 */
export function agentLabel(agent: string | undefined): string {
	return agent ?? "?";
}

export function truncateParallelOutput(output: string): string {
	const result = truncateHead(output, { maxBytes: PER_TASK_OUTPUT_CAP });
	if (!result.truncated) return output;
	return `${result.content}\n\n[Output truncated: ${result.totalBytes - result.outputBytes} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name as string, args: part.arguments as Record<string, any> });
			}
		}
	}
	return items;
}

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
	// 防孤儿工作：任一任务失败（如子进程 30min 超时/外部 abort 抛 'Subagent was aborted'）
	// 后 Promise.all 立即拒绝，若分发循环继续出队会 spawn 新子进程且结果无人消费。
	// aborted 标志让 worker 循环停止出队；internal controller 通过 runSubprocessAgent
	// 现有 signal→scheduleKillChain 链路向已 spawn 的子进程发 SIGTERM。
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

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Resolve which model ID a subagent process should use: agent override, else current session model. */
function resolveModelId(
	agentModel: string | undefined,
	currentModel: { id?: string; provider?: string } | undefined,
): string | undefined {
	if (agentModel) return agentModel;
	if (currentModel?.id && currentModel?.provider) return `${currentModel.provider}/${currentModel.id}`;
	return undefined;
}

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

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	currentModel?: { id?: string; provider?: string },
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return runSubprocessAgent(
			{
				name: agentName || "default",
				description: "通用子代理（无预定义角色时使用）",
				systemPrompt: DEFAULT_SYSTEM_PROMPT,
				source: "user",
				filePath: "",
			},
			defaultCwd,
			task,
			cwd,
			step,
			signal,
			onUpdate,
			makeDetails,
			currentModel,
		);
	}

	return runSubprocessAgent(agent, defaultCwd, task, cwd, step, signal, onUpdate, makeDetails, currentModel);
}

async function runSubprocessAgent(
	agent: AgentConfig,
	defaultCwd: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	currentModel?: { id?: string; provider?: string },
): Promise<SingleResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	const resolvedModel = resolveModelId(agent.model, currentModel);
	if (resolvedModel) args.push("--model", resolvedModel);
	const effectiveTools = resolveAgentTools(agent);
	if (effectiveTools && effectiveTools.length > 0) args.push("--tools", effectiveTools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, buildAgentPrompt(agent));
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			// 整体超时兜底：provider 挂起（请求永不返回）时子进程无限运行、
			// 用户不中止则常驻孤儿（最多 MAX_CONCURRENCY 个）。30 分钟上限
			// SIGTERM→SIGKILL 链终止；超时按失败结束（exitCode 124 语义）。
			const totalTimer = setTimeout(() => {
				wasAborted = true;
				scheduleKillChain(proc);
			}, 30 * 60 * 1000);
			totalTimer.unref?.();
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = calculateContextTokens(usage);
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				// 有上限累积：挂死/异常任务 stderr 无限增长会撑爆内存（stdout 走 50KB cap，
				// stderr 此前无任何限制）
				currentResult.stderr += data.toString();
				if (currentResult.stderr.length > 50 * 1024) {
					currentResult.stderr = currentResult.stderr.slice(-50 * 1024);
				}
			});

			proc.on("close", (code) => {
				clearTimeout(totalTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (err: Error) => {
				// 审计 HIGH：此前静默 resolve(1)——E2BIG（参数超长）/ENOENT 等错误信息丢失，
				// 链式调用表现为整链无声失败无原因。透传到结果：exitCode=1 + errorMessage，
				// isFailedResult→getResultOutput 会把原因带回主会话。
				// 审计 LOW：spawn 失败不触发 close → totalTimer 不被清，悬挂至 30min 超时
				clearTimeout(totalTimer);
				currentResult.errorMessage = `子进程启动失败: ${err.message}`;
				currentResult.stderr += `子进程启动失败: ${err.message}\n`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					scheduleKillChain(proc);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (optional, default general-purpose)" })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (optional, default general-purpose)" })),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

interface SubagentToolParams {
	agent?: string;
	task?: string;
	tasks?: { agent?: string; task: string; cwd?: string }[];
	chain?: { agent?: string; task: string; cwd?: string }[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate tasks to subagents for parallel/isolated work",
		description: [
			"Delegate tasks to subagents with isolated context windows.",
			"Modes: single (task, optional agent), parallel (tasks array), chain (sequential steps with {previous} placeholder).",
			"Usage scenarios, agents (scout/worker/reviewer) and delegation guidance: see the Proactive Delegation section in the system prompt.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as unknown as SubagentToolParams;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const currentModel = ctx.model as { id?: string; provider?: string } | undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: single (task, optional agent), parallel (tasks array) or chain (chain array).`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					if (!ctx.hasUI) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents require UI confirmation. Run in interactive mode or set confirmProjectAgents=false." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// 审计 LOW：step.task 缺失时 applyPreviousPlaceholder 抛 TypeError 炸整个
					// tool call（parallel 路径对 undefined 容忍，两路不一致）——空串兜底
					const taskWithContext = applyPreviousPlaceholder(step.task ?? '', previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						currentModel,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: truncateParallelOutput(getFinalOutput(results[results.length - 1].messages) || "(no output)") }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > getMaxParallelTasks())
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${getMaxParallelTasks()}${isTermuxEnv() ? ' (Termux 环境限制)' : ''}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent ?? "default",
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					getMaxConcurrency(isLocalProvider(currentModel?.provider)),
					async (t, index, internalSignal) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						// 内部信号已由 mapWithConcurrencyLimit 转发外部 abort：任一任务失败/外部中止
						// 时向所有已 spawn 的子进程发 SIGTERM，避免孤儿
						internalSignal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						currentModel,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					currentModel,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					// 审计 MEDIUM：single/chain 此前无字节封顶，超长子代理输出直入主会话
					// 可挤爆上下文（parallel 已有 50KB cap）——同 cap 截断，完整输出仍在 details
					content: [{ type: "text", text: truncateParallelOutput(getFinalOutput(result.messages) || "(no output)") }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(rawArgs, theme, _context) {
			const args = rawArgs as unknown as SubagentToolParams;
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display；缺 task 兜底（模型输出可能缺字段）
					const preview = taskPreview(step.task);
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", agentLabel(step.agent)) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = taskPreview(t.task);
					text += `\n  ${theme.fg("accent", agentLabel(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
