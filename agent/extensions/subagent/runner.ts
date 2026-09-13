import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { calculateContextTokens, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { SingleResult, SubagentDetails, OnUpdateCallback } from "./types.ts";
import {
  getFinalOutput,
  resolveAgentTools,
  buildAgentPrompt,
  scheduleKillChain,
  isLocalProvider,
  getMaxConcurrency,
} from "./helpers.ts";

// ── Core Agent Runner ──

/** Resolve which model ID a subprocess agent should use: agent override, else current session model. */
function resolveModelId(
	agentModel: string | undefined,
	currentModel: { id?: string; provider?: string } | undefined,
): string | undefined {
	if (agentModel) return agentModel;
	if (currentModel?.id && currentModel?.provider) return `${currentModel.provider}/${currentModel.id}`;
	return undefined;
}

/**
 * Find active plan.md (Anthropic artifact flow pattern).
 * Scan plans/ directory, take latest plan.md file content (max 2KB inject into context).
 */
function findActivePlan(): string | null {
	try {
		const plansDir = path.join(os.homedir(), '.pi', 'plans')
		if (!fs.existsSync(plansDir)) return null
		const entries = fs.readdirSync(plansDir, { withFileTypes: true })
			.filter(e => e.isDirectory() && e.name.startsWith('plan-'))
		if (entries.length === 0) return null
		// Sort by directory name (plan-YYYYMMDD-HHmmss), take latest
		entries.sort((a, b) => b.name.localeCompare(a.name))
		for (const entry of entries) {
			const planPath = path.join(plansDir, entry.name, 'plan.md')
			if (fs.existsSync(planPath)) {
				const content = fs.readFileSync(planPath, 'utf-8')
				// Truncate to 2KB, prevent context bloat
				return content.length > 2048 ? content.slice(0, 2048) + '\n...（已截断）' : content
			}
		}
		return null
	} catch {
		return null
	}
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

export async function runSubprocessAgent(
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
			// Artifact flow (Anthropic pattern): auto-inject active plan.md as upstream artifact context
			let fullPrompt = buildAgentPrompt(agent);
			const activePlan = findActivePlan();
			if (activePlan) {
				fullPrompt += `\n\n---\n## 当前活跃计划（plan.md）\n以下是最新的执行计划，请确保你的工作对齐此计划：\n\n${activePlan}`;
			}
			const tmp = await writePromptToTempFile(agent.name, fullPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			// Audit HIGH fix: filter sensitive environment variables, prevent API keys/tokens leaking to subprocess
			const SENSITIVE_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|AWS_SECRET|PI_SESSION_ID|PI_AUTH|PI_API_KEY)/i;
			const filteredEnv: Record<string, string> = {};
			for (const [k, v] of Object.entries(process.env)) {
				if (v !== undefined && !SENSITIVE_ENV.test(k)) filteredEnv[k] = v;
			}
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: filteredEnv,
			});
			// Overall timeout fallback: provider hangs (request never returns) causing subprocess infinite run,
			// user doesn't abort then orphaned (max MAX_CONCURRENCY). 30 minute upper limit
			// SIGTERM→SIGKILL chain termination; timeout counted as failed exit (exitCode 124 semantics).
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
				// Upper bound accumulation: hung/abnormal tasks stderr infinite growth explodes memory (stdout uses 50KB cap,
				// stderr previously had no limits)
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
				// Audit HIGH: previously silent resolve(1) - E2BIG (args too long)/ENOENT etc error info lost,
				// chain call表现为整链无声失败无原因。透传到结果：exitCode=1 + errorMessage，
				// isFailedResult→getResultOutput 会把原因带回主会话。
				// Audit LOW: spawn failure doesn't trigger close → totalTimer not cleared, hangs until 30min timeout
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

export async function runSingleAgent(
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
				systemPrompt: "你是通用子代理，在独立上下文中执行委派的任务。",
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
