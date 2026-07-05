/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis and plan-driven execution.
 * Merged from built-in plan-mode + stagefright5/pi-agent-extensions features.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 * - Clarifying questions + impact analysis before planning
 * - Accidental plan replacement protection on follow-up questions
 * - Per-plan git repo at ~/.pi/plans/ for versioning
 * - /plandiff command to view plan iteration differences
 * - /planqa command to view plan discussion history
 * - Full state persistence across session resume
 */

import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	extractTodoItems,
	isPlanRevisionIntent,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.ts";
import { getTokenPressureTag, recordToolUsage, resetBudget } from "../../lib/token-budget.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

const PLANS_DIR = join(homedir(), ".pi", "plans");

type QAPair = { role: "user" | "assistant"; content: string };

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let planPresented = false;
	let planDir: string | null = null;
	let qaMessages: QAPair[] = [];
	let planModeFullInjected = false;
	let knownTodoHash = 0;

	function todoHash(): number {
		let h = 0;
		for (const t of todoItems) {
			h = ((h << 5) - h + t.step) | 0;
			for (let i = 0; i < t.text.length; i++) {
				h = ((h << 5) - h + t.text.charCodeAt(i)) | 0;
			}
			h = ((h << 5) - h + (t.completed ? 1 : 0)) | 0;
		}
		return h;
	}

	pi.registerFlag("plan", {
		description: `以规划模式启动（只读探索）`,
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`),
			);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];
		planPresented = false;
		planDir = null;
		qaMessages = [];

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	async function savePlanIteration(
		planText: string,
		iteration: number,
	): Promise<string> {
		const timestamp = Date.now();
		const dir = planDir ?? join(PLANS_DIR, `plan-${timestamp}`);

		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "plan.md"), planText);

		try {
			if (iteration === 1 || !planDir) {
				execSync("git init && git add plan.md && git commit -m 'initial'", {
					cwd: dir,
					encoding: "utf-8",
				});
			} else {
				execSync(`git add plan.md && git commit -m 'iteration ${iteration}'`, {
					cwd: planDir,
					encoding: "utf-8",
				});
			}
		} catch {
			// git not available or init failed — silently skip versioning
		}

		return dir;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			planPresented,
			planDir,
			qaMessages,
		});
	}

	pi.registerCommand("plan", {
		description: `切换规划模式（只读探索）`,
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: `显示当前规划任务列表`,
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems
				.map(
					(item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`,
				)
				.join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerCommand("plandiff", {
		description: `显示当前与上一版规划的差异`,
		handler: async (_args, ctx) => {
			if (!planDir) {
				ctx.ui.notify("No plan to diff. Create a plan first.", "info");
				return;
			}
			try {
				const diff = execSync(
					"git diff HEAD~1..HEAD -- plan.md 2>/dev/null || git show --stat HEAD",
					{ cwd: planDir, encoding: "utf-8" },
				);
				if (!diff.trim()) {
					ctx.ui.notify("No changes from previous iteration.", "info");
					return;
				}
				pi.sendMessage(
					{
						customType: "plan-diff",
						content: `**Plan Diff:**\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``,
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch {
				ctx.ui.notify("No previous iteration to diff against.", "info");
			}
		},
	});

	pi.registerCommand("planqa", {
		description: `显示当前规划讨论的问答历史`,
		handler: async (_args, ctx) => {
			if (qaMessages.length === 0) {
				ctx.ui.notify("No Q&A history yet.", "info");
				return;
			}
			const history = qaMessages
				.map(
					(qa, i) =>
						`**${qa.role === "user" ? "You" : "Agent"}:**\n${qa.content}`,
				)
				.join("\n\n---\n\n");
			pi.sendMessage(
				{
					customType: "plan-qa-history",
					content: `**Plan Q&A History (${qaMessages.length} messages):**\n\n${history}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) =>
							c.type === "text" &&
							(c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const pressureTag = getTokenPressureTag() || "";
		const preamble = pressureTag ? `${pressureTag}\n` : "";
		const content = planModeFullInjected
				? `${preamble}[PLAN MODE] same rules apply. Use /plan to exit.`
				: `${preamble}[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Before creating a plan:
- Ask clarifying questions if requirements are unclear.
- Inspect the codebase to understand current structure.
- Perform impact analysis: identify which files would change, what could break, edge cases.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.

After a plan is presented: if the user asks normal follow-up questions
(why, what, explain), answer in text — do NOT output another Plan: block.
Only produce a revised "Plan:" section when the user explicitly asks for a
revision, change, or update.`;
			planModeFullInjected = true;
			return {
				message: {
					customType: "plan-mode-context",
					content,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const currentHash = todoHash();
			if (currentHash === knownTodoHash) {
				// Still inject pressure tag if non-trivial
				const pressureTag = getTokenPressureTag();
				if (pressureTag) {
					return { message: { customType: "plan-pressure-tag", content: pressureTag, display: false } };
				}
				return;
			}
			knownTodoHash = currentHash;
			const pressureTag = getTokenPressureTag() || "";
			const preamble = pressureTag ? `${pressureTag}\n` : "";
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `${preamble}[EXECUTING: ${todoItems.filter(t => t.completed).length}/${todoItems.length} done]

Remaining:
${todoList}`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `**Plan Complete!** ✓\n\n${completedList}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages]
			.reverse()
			.find(isAssistantMessage);
		if (lastAssistant) {
			const lastText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(lastText);
			if (extracted.length > 0) {
				const isNewPlan = !planPresented || isPlanRevisionIntent(lastText);
				if (isNewPlan && extracted.length > 0) {
					todoItems = extracted;
					// Save plan to git repo
					let iteration = 1;
					if (planDir) {
						try {
							iteration =
								Number(
									execSync("git rev-list --count HEAD", {
										cwd: planDir,
										encoding: "utf-8",
									}).trim(),
								) + 1;
						} catch {
							// fallback: increment beyond known commits
							iteration = 2;
						}
					}
					savePlanIteration(lastText, iteration).then((dir) => {
						planDir = dir;
						persistState();
					});
				}
				planPresented = true;
			}

			// Capture Q&A pair when plan has been presented
			if (planPresented) {
				const lastUser = [...event.messages]
					.reverse()
					.find((m) => m.role === "user");
				if (lastUser) {
					const userContent =
						typeof lastUser.content === "string" ? lastUser.content : "";
					if (userContent.trim()) {
						qaMessages.push({ role: "user", content: userContent });
					}
				}
				qaMessages.push({
					role: "assistant",
					content: lastText.slice(0, 500),
				});

				// Trim Q&A to last 3 pairs (max 6 entries)
				if (qaMessages.length > 6) {
					qaMessages = qaMessages.slice(-6);
				}
			}
		}

		// Show plan steps; conditionally prompt for next action
		if (todoItems.length > 0) {
			const todoListText = todoItems
				.map((t, i) => `${i + 1}. ☐ ${t.text}`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plan-todo-list",
					content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		// Only show choice when todos actually changed or plan is brand new
		const needsChoice = todoItems.length > 0 && todoHash() !== knownTodoHash;
		if (!needsChoice) return;

		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0
				? "Execute the plan (track progress)"
				: "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			knownTodoHash = todoHash();
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);

			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{
					customType: "plan-mode-execute",
					content: execMessage,
					display: true,
				},
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		resetBudget();
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plan-mode",
			)
			.pop() as
			| {
					data?: {
						enabled: boolean;
						todos?: TodoItem[];
						executing?: boolean;
						planPresented?: boolean;
						planDir?: string | null;
						qaMessages?: QAPair[];
					};
			  }
			| undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			planPresented = planModeEntry.data.planPresented ?? planPresented;
			planDir = planModeEntry.data.planDir ?? planDir;
			qaMessages = planModeEntry.data.qaMessages ?? qaMessages;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (
					entry.type === "message" &&
					"message" in entry &&
					isAssistantMessage(entry.message as AgentMessage)
				) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
