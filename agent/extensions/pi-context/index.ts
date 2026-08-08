import { truncateHead, truncateTail, type ExtensionAPI, type ToolResultEvent, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	setContextWindow,
	recordCacheUsage,
} from "../../lib/context-budget.ts";import { computeCompactThreshold, makeAutoContinueGate, makeCompactDecider } from "../../lib/auto-compact.ts";
import { pruneThinkingBudget, pruneToolResults, type PruneMessage } from "../../lib/prune.ts";
import {
	formatUsageSummary,
	loadDiagLines,
	recordAutoCompact,
	recordPrune,
	recordUsage,
	type UsageRecord,
} from "../../lib/usage-diag.ts";

export default function (pi: ExtensionAPI) {
	const MAX_TOOL_BYTES = 5000;
	const MAX_OTHER_TOOL_BYTES = 20 * 1024;
	// 按窗口比例自动压缩（见 lib/auto-compact.ts 说明）
	const compactDecider = makeCompactDecider();

	// 压缩后自动继续门（见 lib/auto-compact.ts AutoContinueGate）：
	// ctx.compact() 触发的 session_compact reason 恒为 "manual"（无法与用户手动
	// /compact 区分），用门判断"压缩完成后是否自动继续"。
	const autoContinueGate = makeAutoContinueGate();

	// 诊断类消息（/usage-diag 输出）只展示、不进 LLM 上下文
	const DIAG_CUSTOM_TYPES = new Set(["usage-diag"]);

	// R2/R3：context 阶段确定性过滤（结果每轮一致，不破坏缓存前缀）
	pi.on("context", (event) => {
		let messages = event.messages;
		let modified = false;

		// 诊断类 custom 消息（/usage-diag 输出）仅展示，不进 LLM 上下文
		const filteredMessages: typeof messages = [];
		for (const m of messages) {
			// AgentMessage 为官方 union 类型，custom 消息的 customType 不在
			// 基础成员上，先按 role 收窄再读取
			const customType = m.role === "custom" ? (m as { customType?: string }).customType : undefined;
			if (customType && DIAG_CUSTOM_TYPES.has(customType)) {
				modified = true;
				continue;
			}
			filteredMessages.push(m);
		}
		if (modified) messages = filteredMessages;

		// Prune：工具输出分层擦除（借鉴 opencode，零 LLM 成本）。
		// 最近 2 轮 + 40K 保护带内保留，更早的旧工具输出替换为占位；
		// 回收 <20K 不应用。判定确定性、擦除点单调后移 → 缓存前缀稳定。
		const pruned = pruneToolResults(messages as unknown as PruneMessage[]);
		if (pruned.modified) {
			messages = pruned.messages as unknown as typeof messages;
			modified = true;
			recordPrune(pruned.prunedTokens, pruned.prunedChars, pruned.prunedCount);
		}

		let latestSummaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "compactionSummary") {
				latestSummaryIdx = i;
				break;
			}
		}
		if (latestSummaryIdx >= 0) {
			const hasOlder = messages.slice(0, latestSummaryIdx).some(
				(m) => m.role === "compactionSummary",
			);
			if (hasOlder) {
				messages = messages.filter(
					(m, i) => !(m.role === "compactionSummary" && i !== latestSummaryIdx),
				);
				modified = true;
			}
		}

		// thinking 保留按 token 预算（早期按"保留最近 2 轮"数量规则，max 推理级别
		// 下单轮 reasoning 可达 5-10K，2 轮上限不可控）。改为保留最近
		// KEEP_THINKING_TOKENS token 的 thinking：预算耗尽处及更早的全部删除。
		// 确定性：判定只依赖消息内容，内容不变结果不变 → 缓存前缀稳定。
		const thinking = pruneThinkingBudget(messages as unknown as PruneMessage[]);
		if (thinking.modified) {
			messages = thinking.messages as unknown as typeof messages;
			modified = true;
		}
		if (modified) return { messages };
	});

	// R4：工具输出截断（确定性变换，稳定）。
	// bash/read 输出上限 5KB（最常见的超大输出源）；其他工具 20KB 兜底
	// （防止未来新工具输出失控直达上下文，子代理等合理输出不受影响）。
	pi.on("tool_result", (event: ToolResultEvent) => {
		const cap = event.toolName === "bash" || event.toolName === "read" ? MAX_TOOL_BYTES : MAX_OTHER_TOOL_BYTES;
		const totalText = event.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		if (Buffer.byteLength(totalText, "utf8") <= cap) return;

		const truncate = event.toolName === "bash" ? truncateTail : truncateHead;
		const result = truncate(totalText, { maxBytes: cap });
		const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;

		return {
			content: [
				{
					type: "text",
					text: `${result.content}\n\n[...truncated ${omittedBytes} bytes]`,
				},
			],
			details: event.details,
		};
	});

	// 缓存命中统计：聚合每次调用的 cacheRead/cacheWrite（仅记录，不注入上下文）
	pi.on("tool_result", (event: ToolResultEvent) => {
		const usage: Usage | undefined = event.usage;
		if (!usage) return;
		recordCacheUsage(
			typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
			typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		);
	});

	// 每轮用量记录 + 按窗口比例自动压缩
	// 根因修复：pi 内置压缩阈值 = 窗口 - reserveTokens，对 1M 窗口模型高达 96.7 万，
	// 会话每轮全量重发持续膨胀。这里在 20%（大窗口）/85%（小窗口）处主动触发压缩。
	// 注意：ctx.compact() 会 abort 当前 agent 运行，因此判定放在 agent_end（run 结束）而非 turn_end。
	pi.on("turn_end", (event: TurnEndEvent) => {
		const usage = (event.message as { usage?: Usage } | undefined)?.usage;
		if (!usage || typeof usage.input !== "number") return;

		const input = usage.input || 0;
		const cacheRead = usage.cacheRead || 0;
		recordUsage({
			ts: Date.now(),
			input,
			cacheRead,
			cacheWrite: usage.cacheWrite || 0,
			output: usage.output || 0,
			reasoning: usage.reasoning || 0,
			total: usage.totalTokens || 0,
			contextTokens: input + cacheRead,
			compacted: false,
		});
	});

	pi.on("agent_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
		const contextWindow = usage.contextWindow;
		if (!contextWindow || contextWindow <= 0) return;

		const decision = compactDecider.decide(usage.tokens, contextWindow);
		if (!decision.shouldCompact) return;

		recordAutoCompact(usage.tokens, decision.threshold);
		compactDecider.markCompact();
		autoContinueGate.arm();
		ctx.compact({
			onError: (err) => {
				autoContinueGate.disarm();
				// 压缩失败不致命：内置 96.7 万兜底仍在
				console.error("pi-context: auto-compact failed:", err);
			},
		});
	});

	// 压缩完成后自动继续（借鉴 opencode compaction.autocontinue）：
	// 压缩会 abort 当前 agent，运行已结束；session_compact 由 compact() 内部 emitted，
	// 此时注入继续指令并启动新一轮。
	// 防递归：180s cooldown 保证新轮结束不会立刻再次压缩。
	pi.on("session_compact", () => {
		if (!autoContinueGate.shouldContinue()) return;
		pi.sendMessage(
			{
				customType: "continue-after-compact",
				content:
					"上下文已自动压缩。如果你还有下一步行动，请继续执行；如果已完成或不确定，请停下来向用户说明。",
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	// 会话恢复：历史全量重发前先检查是否已超压缩阈值。
	// resume 大会话时上下文立即回到之前大小（如 300K），若等首轮 agent_end
	// 再压缩会浪费一轮全量发送；此处无 agent 运行时直接压缩（abort 是 no-op）。
	// 注意：compact() 会 emit session_compact，但 AutoContinueGate 未 arm →
	// 不会触发自动继续（恢复后等待用户输入是正确行为）。
	pi.on("session_start", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
		const contextWindow = usage.contextWindow;
		if (!contextWindow || contextWindow <= 0) return;

		const decision = compactDecider.decide(usage.tokens, contextWindow);
		if (!decision.shouldCompact) return;

		recordAutoCompact(usage.tokens, decision.threshold);
		compactDecider.markCompact();
		ctx.compact({
			onError: (err) => {
				// 恢复时压缩失败不致命：首轮 agent_end 会再判定
				console.error("pi-context: resume compact failed:", err);
			},
		});
	});

	// 用量诊断汇总（输出仅展示，已被 context 过滤排除）
	pi.registerCommand("usage-diag", {
		description: "显示会话 LLM 用量诊断（每轮 input/缓存/输出汇总）",
		handler: async (_args, ctx) => {
			const content = formatUsageSummary(loadDiagLines());
			ctx.ui.notify(
				`usage-diag: ${content.split("\n").length} 行，已发送到聊天（不进 LLM 上下文）。`,
				"info",
			);
			pi.sendMessage(
				{
					customType: "usage-diag",
					content,
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	// 融合 pi-router：before_agent_start 注入主动路由策略 + 档位化压力提示
	// 缓存友好原则：
	//  - 静态的 delegationAdvice 在前（内容永不变化）
	//  - 压力提示仅按档位注入固定文案（档位跳变才改变 system prompt）
	//  - 无压力时 system prompt 与 pi 原生完全一致 → 消息历史缓存前缀稳定
	// 档位基于 auto-compact 阈值比例（早期实现用 contextWindow 的 85%/95%，
	// 但 auto-compact 在 20% 处先触发，85%/95% 永不达到 → 死代码）。
	pi.on("before_agent_start", async (event, ctx) => {
		const usage = ctx.getContextUsage();
		let pressureLine = "";
		if (usage && usage.contextWindow > 0 && typeof usage.tokens === "number") {
			setContextWindow(usage.contextWindow);
			const threshold = computeCompactThreshold(usage.contextWindow);
			if (threshold !== null && threshold > 0) {
				const near = usage.tokens / threshold;
				if (near >= 0.9) {
					pressureLine =
						"\n\n[上下文接近自动压缩阈值（90%）。请用 ctx_note 保存关键决策与进度；压缩会自动触发并继续。]";
				} else if (near >= 0.75) {
					pressureLine =
						"\n\n[上下文接近自动压缩阈值（75%）。优先将探索/独立任务委托给 subagent，关键信息用 ctx_note 保存。]";
				}
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
}
