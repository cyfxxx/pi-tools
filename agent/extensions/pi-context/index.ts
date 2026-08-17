import { truncateHead, truncateTail, type ExtensionAPI, type ToolResultEvent, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import {
	setContextWindow,
	setUsedTokens,
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

// 执行效率指令（静态注入，缓存友好）：批量工具调用 + 抑制中间答复。
// 依据 2026-08 实测：同一任务 pi 40 请求 vs opencode 16（同模型 deepseek-v4-flash），
// 根因是模型每轮仅发 1.4 个工具调用（内核已支持 parallel 批量，agent-loop.js）且
// 每轮输出中间解释文本。此段与 delegationAdvice 同属静态前缀，不随时间变化。
export const EFFICIENCY_ADVICE = `## Execution Efficiency

- Independent tool calls (multiple reads, greps, globs) MUST be issued in a single assistant turn — batch them together; a parallel batch costs only one request.
- During exploration/execution turns, do NOT write explanatory text or progress reports — output tool calls only. Summarize once when everything is done.
- Exception: when todo progress updates are required or a plan summary is requested, output the required structured summary.`;

/**
 * R4 工具输出截断的纯函数（供单测）：超限时截断文本块；
 * 非 text 块（read 返回的图片等）必须原样保留——重建 content 时不得静默丢弃。
 * 未超限返回 undefined（handler 不修改事件）。
 */
export function truncateToolContent(
	toolName: string,
	content: ToolResultEvent["content"],
	cap: number,
): { content: ToolResultEvent["content"]; omittedBytes: number } | undefined {
	const totalText = content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
	if (Buffer.byteLength(totalText, "utf8") <= cap) return undefined;

	const truncate = toolName === "bash" ? truncateTail : truncateHead;
	// 审计 LOW：截断标记约 30-60 字节——maxBytes 减余量，最终字节不超 cap
	const MARK_BUDGET = 64
	const result = truncate(totalText, { maxBytes: Math.max(1, cap - MARK_BUDGET) });
	const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;
	const truncatedText = `${result.content}\n\n[...truncated ${omittedBytes} bytes]`;

	// 审计 LOW：原实现非 text 块前置、文本后置（块顺序改变）；改为原位重建——
	// text 合并到第一个 text 块位置，非 text 块（图片等）保持相对顺序
	const rebuilt: ToolResultEvent["content"] = [];
	let textPlaced = false;
	for (const c of content) {
		if (c.type === "text") {
			if (!textPlaced) {
				rebuilt.push({ type: "text", text: truncatedText });
				textPlaced = true;
			}
		} else {
			rebuilt.push(c);
		}
	}
	if (!textPlaced) rebuilt.push({ type: "text", text: truncatedText });

	return {
		content: rebuilt,
		omittedBytes,
	};
}

// ── 上下文解析 fallback（2026-08-17 修复：opencode-go provider 内核不提供
// contextWindow（model.contextWindow 未配置 → getContextUsage() 返回 undefined），
// 导致 agent_settled/session_start 双路径静默 return、自动压缩从未触发——8-15
// 实测无 auto-compact 事件、12:26 靠内核内置兜底）。
// fallback 链：内核 usage(contextWindow+tokens) → 最近 turn_end 的 provider
// contextTokens（input+cacheRead，每轮有效）+ 配置窗口。窗口来源：
// PI_CONTEXT_WINDOW_FALLBACK 环境变量（默认 1M，deepseek-v4 系列）。
const FALLBACK_CONTEXT_WINDOW = 1_000_000
let fallbackContextWindow = (() => {
  const raw = process.env.PI_CONTEXT_WINDOW_FALLBACK
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_CONTEXT_WINDOW
})()
/** 最近一轮 provider 报告的 contextTokens（turn_end 时更新） */
let lastProviderContextTokens = 0

/** 读取 0-1 比例环境变量；未设置或非法返回 undefined（走默认） */
function readEnvRatio(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined
}

interface ResolvedContext {
  tokens: number
  window: number
}

/**
 * 解析会话上下文信息：优先内核 getContextUsage（含真实 contextWindow），
 * 不可用时回退到最近 provider contextTokens + 配置窗口（自动压缩必须可用）。
 */
function resolveContext(ctx: { getContextUsage?: () => unknown }): ResolvedContext | null {
  const usage = ctx.getContextUsage?.() as
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined
  if (
    usage &&
    typeof usage.tokens === "number" &&
    usage.tokens > 0 &&
    typeof usage.contextWindow === "number" &&
    usage.contextWindow > 0
  ) {
    return { tokens: usage.tokens, window: usage.contextWindow }
  }
  if (lastProviderContextTokens > 0) {
    return { tokens: lastProviderContextTokens, window: fallbackContextWindow }
  }
  return null
}

export default function (pi: ExtensionAPI) {
	const MAX_TOOL_BYTES = 5000;
	const MAX_OTHER_TOOL_BYTES = 20 * 1024;
	// 按窗口比例自动压缩（见 lib/auto-compact.ts 说明；largeRatio/smallRatio
	// 支持 PI_CONTEXT_COMPACT_LARGE_RATIO / PI_CONTEXT_COMPACT_SMALL_RATIO 覆盖）
	const compactDecider = makeCompactDecider(undefined, {
		largeRatio: readEnvRatio("PI_CONTEXT_COMPACT_LARGE_RATIO"),
		smallRatio: readEnvRatio("PI_CONTEXT_COMPACT_SMALL_RATIO"),
	});

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
		const truncated = truncateToolContent(event.toolName, event.content, cap);
		if (!truncated) return;
		return {
			content: truncated.content,
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

	// 每轮用量记录（compacted 死字段已移除：真实压缩事件由 recordAutoCompact 单独记录）
	pi.on("turn_end", (event: TurnEndEvent) => {
		const usage = (event.message as { usage?: Usage } | undefined)?.usage;
		if (!usage || typeof usage.input !== "number") return;

		const input = usage.input || 0;
		const cacheRead = usage.cacheRead || 0;
		const contextTokens = input + cacheRead;
		// 供 agent_settled/session_start fallback（内核无 contextWindow 时自动压缩用）
		lastProviderContextTokens = contextTokens;
		recordUsage({
			ts: Date.now(),
			input,
			cacheRead,
			cacheWrite: usage.cacheWrite || 0,
			output: usage.output || 0,
			reasoning: usage.reasoning || 0,
			total: usage.totalTokens || 0,
			contextTokens,
		});
	});

	// 按窗口比例自动压缩（根因修复：pi 内置压缩阈值 = 窗口 - reserveTokens，对 1M 窗口
	// 模型高达 96.7 万，会话每轮全量重发持续膨胀）。
	// 挂在 agent_settled 而非 agent_end：AgentEndEvent 对扩展无 willRetry 字段（实测
	// types.d.ts），agent_end 时内核可能仍会重试/续跑——此时 ctx.compact() 会 abort
	// 杀掉内核重试轮。agent_settled 语义为"run 完全settled且无重试/压缩/排队续跑"
	// （agent-session.js _emitAgentSettled），此点压缩不会打断任何内核后续动作。
	pi.on("agent_settled", (_event, ctx) => {
		const resolved = resolveContext(ctx);
		if (!resolved) return;
		const { tokens, window: contextWindow } = resolved;

		// 溢出兜底（对齐 dsh CONTEXT_WINDOW_EXCEEDED 路径）：上下文已超窗口时
		// 绕过阈值/冷却强制压缩——比等内核在窗口-reserve 处兜底更早介入，
		// 且保留 32K reserve 余量给模型响应。
		if (tokens >= contextWindow) {
			autoContinueGate.arm();
			ctx.compact({
				customInstructions:
					"上下文已接近/超过模型窗口。请生成结构化摘要，并显式丢弃早期工具输出细节，保留关键决策、文件路径与待办。",
				onComplete: () => {
					recordAutoCompact(tokens, contextWindow);
					compactDecider.markCompact();
				},
				onError: (err) => {
					autoContinueGate.disarm();
					console.error("pi-context: overflow compact failed:", err);
				},
			});
			return;
		}

		const decision = compactDecider.decide(tokens, contextWindow);
		if (!decision.shouldCompact) return;

		autoContinueGate.arm();
		ctx.compact({
			// 仅压缩成功后记账/记时：cooldown 起点取真实完成时刻；
			// 失败不进入 cooldown，下一轮 agent_settled 可重试
			onComplete: () => {
				recordAutoCompact(tokens, decision.threshold);
				compactDecider.markCompact();
			},
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
	// resume 大会话时上下文立即回到之前大小（如 300K），若等首轮 agent_settled
	// 再压缩会浪费一轮全量发送；此处无 agent 运行时直接压缩（abort 是 no-op）。
	// 注意：compact() 会 emit session_compact，但 AutoContinueGate 未 arm →
	// 不会触发自动继续（恢复后等待用户输入是正确行为）。
	pi.on("session_start", (_event, ctx) => {
		const resolved = resolveContext(ctx);
		if (!resolved) return;
		const { tokens, window: contextWindow } = resolved;

		const decision = compactDecider.decide(tokens, contextWindow);
		if (!decision.shouldCompact) return;

		ctx.compact({
			// 与 agent_settled 一致：成功后才记账/记时
			onComplete: () => {
				recordAutoCompact(tokens, decision.threshold);
				compactDecider.markCompact();
			},
			onError: (err) => {
				// 恢复时压缩失败不致命：首轮 agent_settled 会再判定
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
		const resolved = resolveContext(ctx);
		let pressureLine = "";
		if (resolved) {
			setContextWindow(resolved.window);
			setUsedTokens(resolved.tokens); // 真实用量校准：plan-mode 等共享库消费者压力提示随之准确
			const threshold = computeCompactThreshold(resolved.window);
			if (threshold !== null && threshold > 0) {
				const near = resolved.tokens / threshold;
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
			systemPrompt: event.systemPrompt + "\n\n" + delegationAdvice + "\n\n" + EFFICIENCY_ADVICE,
		};
	});
}
