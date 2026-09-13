import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult, SubagentDetails, DisplayItem } from "./types.ts";
import {
  COLLAPSED_ITEM_COUNT,
  formatTokens,
  formatUsageStats,
  getFinalOutput,
  isFailedResult,
  taskPreview,
  agentLabel,
} from "./helpers.ts";

// ── Display Items ──

export function getDisplayItems(messages: Message[]): DisplayItem[] {
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

// ── Tool Call Formatting ──

export function formatToolCall(
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

// ── Rendering Helpers ──

function renderDisplayItems(items: DisplayItem[], themeFg: (color: any, text: string) => string, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += themeFg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			text += `${themeFg("toolOutput", item.text)}\n`;
		} else {
			text += `${themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg)}\n`;
		}
	}
	return text.trimEnd();
}

function aggregateUsage(results: SingleResult[]) {
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
}

// ── Main Render Functions ──

export function renderSingleResult(
	r: SingleResult,
	expanded: boolean,
	theme: any,
): Text | Container {
	const mdTheme = getMarkdownTheme();
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
		text += `\n${renderDisplayItems(displayItems, theme.fg.bind(theme), COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

export function renderChainResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: any,
): Text | Container {
	const mdTheme = getMarkdownTheme();
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
		else text += `\n${renderDisplayItems(displayItems, theme.fg.bind(theme), 5)}`;
	}
	const usageStr = formatUsageStats(aggregateUsage(details.results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

export function renderParallelResult(
	details: SubagentDetails,
	expanded: boolean,
	theme: any,
): Text | Container {
	const mdTheme = getMarkdownTheme();
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
		else text += `\n${renderDisplayItems(displayItems, theme.fg.bind(theme), 5)}`;
	}
	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(details.results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}
