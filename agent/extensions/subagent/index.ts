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

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import type { SingleResult, SubagentDetails, SubagentToolParams } from "./types.ts";
import {
  isTermuxEnv,
  getMaxParallelTasks,
  getMaxConcurrency,
  isLocalProvider,
  classifyTaskRisk,
  riskToolRestrictions,
  truncateParallelOutput,
  mapWithConcurrencyLimit,
} from "./helpers.ts";
import {
  runSingleAgent,
} from "./runner.ts";
import {
  getDisplayItems,
  formatToolCall,
  renderSingleResult,
  renderChainResult,
  renderParallelResult,
} from "./rendering.ts";
import {
  getFinalOutput,
  isFailedResult,
  getResultOutput,
  applyPreviousPlaceholder,
  taskPreview,
  agentLabel,
} from "./helpers.ts";

// Re-export for tests and external usage
export { isTermuxEnv, getMaxParallelTasks, getMaxConcurrency, isLocalProvider } from "./helpers.ts";
export { resolveAgentTools, buildAgentPrompt, scheduleKillChain } from "./helpers.ts";
export { formatTokens, formatUsageStats } from "./helpers.ts";
export { getFinalOutput, isFailedResult, getResultOutput, capPreviousOutput, applyPreviousPlaceholder } from "./helpers.ts";
export { taskPreview, agentLabel, truncateParallelOutput } from "./helpers.ts";
export { classifyTaskRisk, riskToolRestrictions } from "./helpers.ts";
export { mapWithConcurrencyLimit } from "./helpers.ts";
export type { RiskLevel } from "./types.ts";

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
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

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
			// 2026-08-28 审计：确认开关不再由模型参数控制（传 false 即跳过 UI 确认门），恒为 true
			const confirmProjectAgents = true;
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
							content: [{ type: "text", text: "Canceled: project-local agents require UI confirmation. Run in interactive mode." }],
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
					const chainUpdate = onUpdate
						? (partial: any) => {
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
				// 风险分级（Anthropic 1σ/2σ/3σ）：根据任务内容自动分级
				const riskLevel = classifyTaskRisk(params.task);
				const riskHint = riskLevel !== "1σ" ? ` [risk=${riskLevel}]` : "";

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
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}${riskHint}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					// 审计 MEDIUM：single/chain 此前无字节封顶，超长子代理输出直入主会话
					// 可挤爆上下文（parallel 已有 50KB cap）——同 cap 截断，完整输出仍在 details
					content: [{ type: "text", text: `${riskHint ? riskHint + " " : ""}${truncateParallelOutput(getFinalOutput(result.messages) || "(no output)")}` }],
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

			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded, theme);
			}

			if (details.mode === "chain") {
				return renderChainResult(details, expanded, theme);
			}

			if (details.mode === "parallel") {
				return renderParallelResult(details, expanded, theme);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
