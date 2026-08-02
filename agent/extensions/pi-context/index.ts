import { truncateHead, truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	setContextWindow,
	recordCacheUsage,
} from "../../lib/context-budget.ts";

export default function (pi: ExtensionAPI) {
	const MAX_TOOL_BYTES = 5000;
	const KEEP_THINKING_TURNS = 2;

	// R1（message_end 剥离 thinking）已移除：它在消息产生时无法判断新旧轮次，
	// 与 R3「保留最近 KEEP_THINKING_TURNS 轮 thinking」矛盾。统一由 R3 在 context 阶段剪枝。

	// R2/R3：context 阶段确定性过滤（结果每轮一致，不破坏缓存前缀）
	pi.on("context", (event) => {
		let messages = event.messages;
		let modified = false;

		let latestSummaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as any).role === "compactionSummary") {
				latestSummaryIdx = i;
				break;
			}
		}
		if (latestSummaryIdx >= 0) {
			const hasOlder = messages.slice(0, latestSummaryIdx).some(
				(m: any) => m.role === "compactionSummary",
			);
			if (hasOlder) {
				messages = messages.filter(
					(m: any, i: number) => !(m.role === "compactionSummary" && i !== latestSummaryIdx),
				);
				modified = true;
			}
		}

		const assistantIndices: number[] = [];
		messages.forEach((m: any, i: number) => {
			if (m.role === "assistant") assistantIndices.push(i);
		});
		if (assistantIndices.length > KEEP_THINKING_TURNS) {
			const threshold = assistantIndices[assistantIndices.length - KEEP_THINKING_TURNS];
			messages = messages.map((m: any, i: number) => {
				if (i < threshold && m.role === "assistant" && m.content) {
					const filtered = m.content.filter((b: any) => b.type !== "thinking");
					if (filtered.length < m.content.length) {
						modified = true;
						return { ...m, content: filtered };
					}
				}
				return m;
			});
		}

		if (modified) return { messages };
	});

	// R4：工具输出截断（确定性变换，稳定）
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "read") return;
		const totalText = event.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
		if (Buffer.byteLength(totalText, "utf8") <= MAX_TOOL_BYTES) return;

		const truncate = event.toolName === "bash" ? truncateTail : truncateHead;
		const result = truncate(totalText, { maxBytes: MAX_TOOL_BYTES });
		const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;

		return {
			content: [
				{
					type: "text",
					text: `${result.content}\n\n[...truncated ${omittedBytes} bytes]`,
				} as any,
			],
			details: event.details,
		};
	});

	// 缓存命中统计：聚合每次调用的 cacheRead/cacheWrite（仅记录，不注入上下文）
	pi.on("tool_result", (event) => {
		const usage = (event as any).usage;
		if (!usage) return;
		recordCacheUsage(
			typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : undefined,
			typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : undefined,
		);
	});

	// 融合 pi-router：before_agent_start 注入主动路由策略 + 档位化压力提示
	// 缓存友好原则：
	//  - 静态的 delegationAdvice 在前（内容永不变化）
	//  - 压力提示仅 high/critical 注入固定文案（档位跳变才改变 system prompt）
	//  - 无压力时 system prompt 与 pi 原生完全一致 → 消息历史缓存前缀稳定
	pi.on("before_agent_start", async (event, ctx) => {
		const usage = ctx.getContextUsage();
		let pressureLine = "";
		if (usage && usage.contextWindow > 0 && typeof usage.tokens === "number") {
			setContextWindow(usage.contextWindow);
			const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
			if (pct >= 95) {
				pressureLine =
					"\n\n[上下文接近满（>95%）。请用 ctx_note 保存关键决策与进度，然后建议用户执行 /compact。]";
			} else if (pct >= 85) {
				pressureLine =
					"\n\n[上下文压力较高（>85%）。优先将探索/独立任务委托给 subagent，关键信息用 ctx_note 保存。]";
			}
		}

		const delegationAdvice = `## Proactive Delegation${pressureLine}

You have access to \`subagent\` tool with specialized agents (scout, planner, worker, reviewer). Use them proactively:

| Scenario | Action | Why |
|----------|--------|-----|
| Codebase exploration ("find where X is", "how does Y work") | Call \`subagent\` with \`scout\` agent | Scout runs in isolated context, returns compressed summary — keeps your main context clean |
| 2+ independent subtasks | Call \`subagent\` parallel mode | Runs tasks one at a time in isolated contexts instead of N sequential turns that bloat the main conversation |
| Multi-step implementation | Call \`subagent\` chain: scout→planner→worker | Each step has isolated context, no context pollution |
| Reading many files (>3) | Delegate to a worker agent instead | Keeps your context window clean and focused |
| Pure research ("explain architecture") | Delegate entirely to scout agent | Consume only the compressed summary |

**Decision heuristic:**
- Ask yourself: "Can this task be done in an isolated context?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Will this task make my context window >70% full?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Are there independent sub-tasks?"
- If yes → parallel \`subagent\``;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + delegationAdvice,
		};
	});

	pi.registerCommand("ping", {
		description: "检查 pi-context 是否生效",
		usage: "/ping",
		handler: (_args, ctx) => {
			ctx.ui.notify("pong — pi-context active");
		},
	});
}
