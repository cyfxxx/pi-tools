import { truncateHead, truncateTail, type ExtensionAPI, type ToolResultEvent, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	recordToolEnable,
	recordToolUsage,
	recordUsage,
	type UsageRecord,
} from "../../lib/usage-diag.ts";
import {
	CORE_TOOLS,
	SLEEPING_GROUPS,
	SLEEPING_TOOL_SET,
	buildSleepingSummary,
	computeActiveTools,
} from "./tool-groups.ts";

// 执行效率指令（静态注入，缓存友好）：批量工具调用 + 抑制中间答复。
// 依据 2026-08 实测：同一任务 pi 40 请求 vs opencode 16（同模型 deepseek-v4-flash），
// 根因是模型每轮仅发 1.4 个工具调用（内核已支持 parallel 批量，agent-loop.js）且
// 每轮输出中间解释文本。此段与 delegationAdvice 同属静态前缀，不随时间变化。
export const EFFICIENCY_ADVICE = `## Execution Efficiency

- Independent tool calls (multiple reads, greps, globs) MUST be issued in a single assistant turn — batch them together; a parallel batch costs only one request.
- During exploration/execution turns, do NOT write explanatory text or progress reports — output tool calls only. Summarize once when everything is done.
- Exception: when todo progress updates are required or a plan summary is requested, output the required structured summary.`;

/**
 * 低压力精简版委托建议（静态注入，缓存友好）：
 * 上下文 <75% 自动压缩阈值时只注入要点（~90 token，省 ~280），
 * 完整场景表仅在 ≥75% 压力档注入（见 before_agent_start 档位逻辑）。
 */
export const LOW_PRESSURE_DELEGATION = `## Proactive Delegation

- Codebase exploration / pure research → \`subagent\` (\`scout\`) — isolated context, compressed summary.
- Independent subtasks → \`subagent\` parallel mode; multi-step workflows → chain (scout→planner→worker).
- Reading >3 files or heavy refactors → delegate to keep the main context clean.`;

/** 完整委托建议（含场景表 + 决策启发式），仅在压力档位（≥75% 阈值）注入 */
export const FULL_DELEGATION_ADVICE = `## Proactive Delegation

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

// R4 常量：截断标记约 30-60 字节——maxBytes 减余量，最终字节不超 cap
const MARK_BUDGET = 64;

// ── 压缩可逆快照（2026-08-20，headroom CCR 本地化）──
// auto-compact 是唯一允许改写历史的地方，压缩后原文不可追溯。
// 在压缩触发前把当前消息全文落盘 logs/compact-snapshots/，供按需检索（bash/ls 查看）。
// 纯落盘不进注入面/不入上下文 → 零缓存影响。快照取 context 阶段的过滤后 messages
// （已含 R4 截断结果），最接近实际进入模型的内容。
const SNAPSHOT_DIR = join(homedir(), ".pi", "logs", "compact-snapshots");
const SNAPSHOT_MAX_FILES = 8; // 文件数上限（保最新，防磁盘膨胀）
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/** context hook 最近一次拿到的 messages（引用，不拷贝——会话内本就持有） */
let lastContextMessages: unknown[] | null = null;

function snapshotBeforeCompact(contextTokens: number, threshold: number): void {
  try {
    if (!lastContextMessages || lastContextMessages.length === 0) return;
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const ts = Date.now();
    const file = join(SNAPSHOT_DIR, `compact-${ts}.json`);
    const payload = {
      ts,
      contextTokens,
      threshold,
      messages: lastContextMessages,
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    // 清理：超龄 + 超量（保最新）
    const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.startsWith("compact-") && f.endsWith(".json"));
    const now = Date.now();
    const stale = new Set(
      files.filter((f) => {
        try {
          return now - statSync(join(SNAPSHOT_DIR, f)).mtimeMs > SNAPSHOT_MAX_AGE_MS;
        } catch {
          return false;
        }
      }),
    );
    const fresh = files.filter((f) => !stale.has(f)).sort().reverse();
    for (const f of fresh.slice(SNAPSHOT_MAX_FILES)) stale.add(f);
    for (const f of stale) {
      try {
        unlinkSync(join(SNAPSHOT_DIR, f));
      } catch {
        /* 并发清理竞态可忽略 */
      }
    }
  } catch (err) {
    // 快照失败不阻塞压缩
    console.error("pi-context: compact snapshot failed:", err);
  }
}


// ── 内容路由：JSON 结构性压缩（2026-08-20，headroom ContentRouter 思想本地化）──
// 结构化大输出（curl|python、API 返回）走确定性结构压缩：解析→二分收缩→再序列化，
// 比"砍头/砍尾"保留更高信息密度。纯规则（同输入必同输出），不含 LLM/时间戳，
// 写时处理不事后改写 → 不破坏 DeepSeek 前缀缓存。
const MAX_JSON_PARSE_BYTES = 2 * 1024 * 1024; // 超大文本跳过解析，防卡顿
const JSON_MIN_ITEMS = 2; // 数组/对象收缩到该粒度仍超限 → 回退通用截断

function jsonBytes(data: unknown): number {
	const s = JSON.stringify(data);
	return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

/** 二分收缩一层：数组保前一半元素；对象保前一半键（保持原文键序）。 */
function shrinkHalf(data: unknown): unknown {
	if (Array.isArray(data)) {
		if (data.length <= JSON_MIN_ITEMS) return data;
		return data.slice(0, Math.ceil(data.length / 2));
	}
	if (data && typeof data === "object") {
		const keys = Object.keys(data as Record<string, unknown>);
		if (keys.length <= JSON_MIN_ITEMS) return data;
		const half = Math.ceil(keys.length / 2);
		const out: Record<string, unknown> = {};
		for (const k of keys.slice(0, half)) out[k] = (data as Record<string, unknown>)[k];
		return out;
	}
	return data;
}

/**
 * JSON 结构性压缩：合法 JSON 且超限时二分收缩到预算内。
 * 失败（非 JSON/解析异常/无法缩小到预算内）返回 undefined → 走通用截断。
 */
function compactJson(
	text: string,
	cap: number,
): { text: string; omittedBytes: number } | undefined {
	if (Buffer.byteLength(text, "utf8") > MAX_JSON_PARSE_BYTES) return undefined;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (jsonBytes(data) <= cap) return undefined; // 防御：调用方已判超限
	const budget = Math.max(1, cap - MARK_BUDGET);
	let current = data;
	for (let i = 0; i < 32; i++) {
		const shrunk = shrinkHalf(current);
		if (shrunk === current) break; // 无法继续缩小（单条超长字符串等）
		current = shrunk;
		if (jsonBytes(current) <= budget) break;
	}
	const outBytes = jsonBytes(current);
	if (outBytes > budget) return undefined; // 仍超限 → 回退通用截断
	const omittedBytes = Buffer.byteLength(text, "utf8") - outBytes;
	if (omittedBytes <= 0) return undefined;
	return {
		text: `${JSON.stringify(current)}\n\n[...truncated ${omittedBytes} bytes]`,
		omittedBytes,
	};
}

// ── 错误输出确定性脱水（12-factor factor-09 本地化）──
// 仅白名单激活（文本中出现错误标记行），折叠连续重复行 + 截断超长行；
// 规则确定性 → 同输入同输出，不破坏缓存；无错误标记时不改动。
const ERROR_MARK_RE = /(^|\n)\s*(Error|ERROR|Traceback \(most recent call last\)|error:)/;
const ERROR_LINE_MAX = 800;
const ERROR_LINE_KEEP = 240;

function dehydrateErrorOutput(text: string): string | undefined {
	if (!ERROR_MARK_RE.test(text)) return undefined;
	const lines = text.split("\n");
	const out: string[] = [];
	let changed = false;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		let run = 1;
		while (i + run < lines.length && lines[i + run] === line) run++;
		if (run > 2) {
			out.push(line, line, `[...${run - 2} 行重复已折叠]`);
			changed = true;
		} else if (Buffer.byteLength(line, "utf8") > ERROR_LINE_MAX) {
			out.push(`${line.slice(0, ERROR_LINE_KEEP)}...[行截断]`);
			changed = true;
		} else {
			out.push(line);
		}
		i += run;
	}
	return changed ? out.join("\n") : undefined;
}

/** 原位重建：合并 text 到第一个 text 块位置，非 text 块（图片等）保持相对顺序。 */
function rebuildTextContent(
	content: ToolResultEvent["content"],
	text: string,
): ToolResultEvent["content"] {
	const rebuilt: ToolResultEvent["content"] = [];
	let textPlaced = false;
	for (const c of content) {
		if (c.type === "text") {
			if (!textPlaced) {
				rebuilt.push({ type: "text", text });
				textPlaced = true;
			}
		} else {
			rebuilt.push(c);
		}
	}
	if (!textPlaced) rebuilt.push({ type: "text", text });
	return rebuilt;
}

/**
 * R4 工具输出截断的纯函数（供单测）：超限时截断文本块；
 * 非 text 块（read 返回的图片等）必须原样保留——重建 content 时不得静默丢弃。
 * 未超限返回 undefined（handler 不修改事件）。
 * 超限后按内容路由处理：JSON 结构压缩 → 错误脱水 → 通用截断（确定性变换，稳定）。
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

	// 内容路由分支 1：JSON 结构性压缩（确定性）
	const jsonCompact = compactJson(totalText, cap);
	if (jsonCompact !== undefined) {
		return { content: rebuildTextContent(content, jsonCompact.text), omittedBytes: jsonCompact.omittedBytes };
	}
	// 内容路由分支 2：错误脱水（把文本降到 cap 内则免截断，保留错误信息）
	const dehy = dehydrateErrorOutput(totalText);
	if (dehy !== undefined && Buffer.byteLength(dehy, "utf8") <= cap) {
		const omitted = Buffer.byteLength(totalText, "utf8") - Buffer.byteLength(dehy, "utf8");
		if (omitted > 0) {
			return { content: rebuildTextContent(content, dehy), omittedBytes: omitted };
		}
	}

	// 通用截断：脱过水则截脱水版（错误信息优先保留），omitted 仍相对原文报告
	const base = dehy ?? totalText;
	const truncate = toolName === "bash" ? truncateTail : truncateHead;
	const result = truncate(base, { maxBytes: Math.max(1, cap - MARK_BUDGET) });
	const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;
	const truncatedText = `${result.content}\n\n[...truncated ${omittedBytes} bytes]`;

	return {
		content: rebuildTextContent(content, truncatedText),
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
// 2026-08-20 曾误改 160K（误判“网关 130-155K 硬裁”——后被证伪：会话内无
// compaction 事件，MISS 轮为缓存 TTL 过期/跨会话边界，上下文 1M 健康增长）。已回滚。
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

	// 重启/恢复场景压缩阈值（占窗口比例）：重启后首轮必全量重发，40% 以上
	// 先压比直接重发省钱。PI_CONTEXT_RESTART_RATIO 可覆盖（0-1 有效，越界回退 0.4）。
	const RESTART_COMPACT_RATIO = readEnvRatio("PI_CONTEXT_RESTART_RATIO") ?? 0.4;

	// 压缩后自动继续门（见 lib/auto-compact.ts AutoContinueGate）：
	// ctx.compact() 触发的 session_compact reason 恒为 "manual"（无法与用户手动
	// /compact 区分），用门判断"压缩完成后是否自动继续"。
	const autoContinueGate = makeAutoContinueGate();

	// 诊断类消息（/usage-diag 输出）只展示、不进 LLM 上下文
	const DIAG_CUSTOM_TYPES = new Set(["usage-diag"]);

	// R2/R3：context 阶段确定性过滤（结果每轮一致，不破坏缓存前缀）
	pi.on("context", (event) => {
		// 供压缩快照用：保存当前消息全文（引用，agent_settled 压缩前落盘可追溯）
		lastContextMessages = event.messages;
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
	// + 工具用量账单（2.5）：按工具累加 per-call usage 到 stats/tool-usage.json
	pi.on("tool_result", (event: ToolResultEvent) => {
		const usage: Usage | undefined = event.usage;
		if (!usage) return;
		recordCacheUsage(
			typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
			typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		);
		recordToolUsage(event.toolName, {
			input: typeof usage.input === "number" ? usage.input : undefined,
			cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
			cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		});
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
			// 压缩前原文快照（可逆追溯，零缓存影响）
			snapshotBeforeCompact(tokens, contextWindow);
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

		// 压缩前原文快照（可逆追溯，零缓存影响）
		snapshotBeforeCompact(tokens, decision.threshold);
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
	// 阈值：恢复场景用 RESTART_COMPACT_RATIO（默认 40% 窗口）而非日常 80%——
	// 重启/恢复后首轮必然全量重发，40% 以上先压比直接重发省钱（对齐 dsh
	// 压缩保留尾部原文的缓存友好原则；依据 2026-08-17 实测：断链轮重发
	// 40-105K 且未命中部分按全价计费）。全新会话 tokens 极小不会误触发。
	pi.on("session_start", (event, ctx) => {
		// 审计 LOW：lastProviderContextTokens 为模块级跨会话残留——新会话启动时
		// 若按旧会话大值走 fallback，会误触发恢复压缩（全新会话 tokens 极小，
		// 阈值 40% 窗口根本不该触发）。new/fork 是新会话身份，清零；
		// resume/reload 是同一会话恢复，保留供断链恢复判定。
		if (event.reason === "new" || event.reason === "fork") lastProviderContextTokens = 0
		const resolved = resolveContext(ctx);
		if (!resolved) return;
		const { tokens, window: contextWindow } = resolved;

		const restartThreshold = Math.floor(contextWindow * RESTART_COMPACT_RATIO);
		if (tokens < restartThreshold) return;

		ctx.compact({
			// 与 agent_settled 一致：成功后才记账/记时
			onComplete: () => {
				recordAutoCompact(tokens, restartThreshold);
				// session_start 压缩不参与日常 decider 的 cooldown（两者独立）
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

	// ── 工具分层与按需加载（2026-08-18，详见 README「工具分层与按需加载」） ──
	// 核心工具 schema 常驻；休眠工具组（browser/admin/autopilot/link）不注入
	// schema，模型需要时调用 enable_tool("组名") 启用（本会话内保持）。
	// 缓存约束：启用是低频显式操作（工具列表变化 = 前缀缓存断裂一次），
	// 禁止任何每轮动态启停实现；启用状态为进程内存态，重启恢复默认分层。
	// 注：getAllTools/getActiveTools 未声明在官方 d.ts（plan-mode 同用法），
	// 运行时内核已提供（agent-session.js getActiveToolNames/allTools），用类型断言。
	const enabledGroups = new Set<string>();
	let layeringApplied = false;

	/** 应用工具分层：全部注册工具减去未启用休眠组的工具 */
	const applyToolLayering = () => {
		const api = pi as ExtensionAPI & { getAllTools(): Array<{ name: string }> };
		const all = api.getAllTools().map((t) => t.name);
		const active = computeActiveTools(all, enabledGroups);
		pi.setActiveTools(active);
		layeringApplied = true;
	};

	/** 生成 /tools list 报告（不进 LLM 上下文，仅展示） */
	const buildToolsReport = () => {
		const api = pi as ExtensionAPI & { getActiveTools(): string[] };
		const activeNames = new Set(api.getActiveTools());
		const lines = ["## 工具分层状态"];
		lines.push(`核心常驻（${CORE_TOOLS.length}）: ${CORE_TOOLS.join(", ")}`);
		for (const g of SLEEPING_GROUPS) {
			const state = enabledGroups.has(g.name) ? "已启用" : "休眠";
			lines.push(`- ${g.name} [${state}]（${g.tools.length}）: ${g.tools.join(", ")}`);
		}
		const inactive = activeNames.size === 0 ? "(未知)" : `${activeNames.size} 个活动`;
		lines.push(`当前活动工具: ${inactive}`);
		return lines.join("\n");
	};

	pi.registerTool({
		name: "enable_tool",
		label: "启用休眠工具组",
		description:
			"启用休眠工具组（browser/admin/autopilot/link）。启用后工具列表更新一次（前缀缓存重算），本会话内保持，重启恢复默认分层；已启用的组再次启用无副作用。",
		parameters: {
			type: "object",
			properties: {
				group: {
					type: "string",
					enum: SLEEPING_GROUPS.map((g) => g.name),
					description: "要启用的休眠工具组名",
				},
			},
			required: ["group"],
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const group = params?.group as string | undefined;
			const g = SLEEPING_GROUPS.find((x) => x.name === group);
			if (!g) {
				return {
					content: [
						{
							type: "text",
							text: `未知工具组: ${group ?? "(空)"}。可用组: ${SLEEPING_GROUPS.map((x) => x.name).join(", ")}`,
						},
					],
					isError: true,
					details: null,
				};
			}
			if (enabledGroups.has(g.name)) {
				return {
					content: [{ type: "text", text: `工具组 ${g.name} 已在启用状态（${g.tools.join(", ")}），无操作。` }],
					details: null,
				};
			}
			enabledGroups.add(g.name);
			applyToolLayering();
			recordToolEnable(g.name, "enable_tool");
			return {
				content: [
					{
						type: "text",
						text: `已启用工具组 ${g.name}: ${g.tools.join(", ")}。本会话内保持可用；重启 pi 后恢复默认分层（如需常驻可后续调整工具分组配置）。`,
					},
				],
				details: null,
			};
		},
	});

	// 工具分层管理命令：/tools list | enable <group>
	pi.registerCommand("tools", {
		description: "工具分层：list 查看分组/状态，enable <group> 启用休眠组（见 /tools help）",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			if (cmd === "enable" && rest[0]) {
				const g = SLEEPING_GROUPS.find((x) => x.name === rest[0]);
				if (!g) {
					ctx.ui.notify(`未知组: ${rest[0]}。可用: ${SLEEPING_GROUPS.map((x) => x.name).join(", ")}`, "warning");
					return;
				}
				enabledGroups.add(g.name);
				applyToolLayering();
				recordToolEnable(g.name, "cmd");
				ctx.ui.notify(`已启用工具组 ${g.name}（${g.tools.join(", ")}），本会话内保持。`, "info");
				return;
			}
			const content = buildToolsReport();
			ctx.ui.notify(`tools: ${SLEEPING_GROUPS.length} 个休眠组，${CORE_TOOLS.length} 个核心工具`, "info");
			pi.sendMessage(
				{
					customType: "tools-report",
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
		// 首次 run 前应用工具分层（此时全部扩展已注册，getAllTools 完整）
		if (!layeringApplied) {
			applyToolLayering();
		} else {
			// 审计 MEDIUM 修复（2026-08-18）：plan-mode 进出计划模式会
			// restoreAllTools(全量) 覆盖分层，layeringApplied 门不再重应用 →
			// 休眠组 schema 永久恢复注入、分层失效。每轮幂等检测：当前活动工具
			// 含（未启用组的）休眠工具则重新应用。仅漂移时 setActiveTools,
			// 无漂移零开销（不触发前缀缓存变化）。
			const cur = (pi as ExtensionAPI & { getActiveTools(): string[] }).getActiveTools();
			const dormant = SLEEPING_GROUPS.filter((g) => !enabledGroups.has(g.name)).flatMap((g) => g.tools);
			if (dormant.some((n) => cur.includes(n))) {
				applyToolLayering();
			}
		}

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

		// 档位化委托建议：低压力（<75% 阈值）注入精简版（~90 token），
		// 完整场景表仅压力档（≥75%/≥90%）注入 + 压力提示行。
		// 档位跳变才改变 system prompt，低档位时缓存前缀更稳定。
		const delegationAdvice = pressureLine
			? FULL_DELEGATION_ADVICE + "\n" + pressureLine
			: LOW_PRESSURE_DELEGATION;

		// 休眠工具组简介（静态，缓存友好——不随启用状态变化）
		const toolSummary = buildSleepingSummary();

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n" +
				delegationAdvice +
				"\n\n" +
				EFFICIENCY_ADVICE +
				"\n\n" +
				toolSummary,
		};
	});
}
