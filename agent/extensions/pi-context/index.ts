import { truncateHead, truncateTail, type ExtensionAPI, type ToolResultEvent, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	setContextWindow,
	setUsedTokens,
	setCompactThreshold,
	markCompacted,
	recordCacheUsage,
	estimateTokens,
} from "../../lib/context-budget.ts";import { computeCompactThreshold, makeAutoContinueGate, makeCompactDecider } from "../../lib/auto-compact.ts";
import { pruneToolResults, type PruneMessage } from "../../lib/prune.ts";
import {
	createState,
	tickThinkingLevel,
	proposeThinkingLevel,
	LEVEL_LADDER,
	type ThinkLevelState,
} from "./thinking-level.ts";
import { recordTaskRecord } from "../../lib/task-record.ts";
import {
	formatUsageSummary,
	loadDiagLines,
	recordAutoCompact,
	recordPrune,
	recordThinkingMeter,
	recordToolCall,
	recordToolEnable,
	recordToolUsage,
	recordUsage,
	pruneToolEvents,
	recomputeToolUsage,
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
// thinking 档位自适应状态（会话内单例；首次 agent_settled 初始化基准档位）
let thinkState: ThinkLevelState | null = null;
// 任务完成即时记录（task #26）：整轮工具计数/最近用量快照/累计轮数/本轮切档标志
let runToolCount = 0;
let lastToolRecomputeTs = 0;
let lastUsageSnap: { input: number; cacheRead: number; output: number } = { input: 0, cacheRead: 0, output: 0 };
let userSeq = 0;
let lastLevelSwitched = false;

/** 从上下文消息提取最后一条实质 user 请求（截 200 字，供任务记录识别主题） */
function extractUserRequest(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "user") continue;
		const c = m.content;
		let text = "";
		if (typeof c === "string") text = c;
		else if (Array.isArray(c)) {
			text = c
				.map((p) =>
					typeof p === "string" ? p : (p as { text?: string })?.text ?? "",
				)
				.join(" ");
		}
		if (text.trim()) return text.trim().slice(0, 200);
	}
	return "";
}

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

// ── 压缩三重门限（2026-08-24 用户策略修订）：上下文长度 >256K 且 任务已完成/
// 阶段性完成 且 本会话无后台任务 且 任务完成后/最后操作后连续 10 分钟无用户操作
// → 才压缩会话。环境变量可覆盖：
//   PI_CONTEXT_ABSOLUTE_TOKENS（默认 256000；<=0 退回窗口比例）
//   PI_CONTEXT_RESTART_TOKENS（重启/恢复场景阈值，默认 100000；
//     看门狗 3 小时自动重启后首轮全量重发，>100K 即提前压缩省钱）
//   PI_CONTEXT_IDLE_MS（默认 600000=10 分钟；<=0 禁用空闲窗门）
//   PI_CONTEXT_TASK_GATE（默认 on；off 禁用任务门）
//   PI_CONTEXT_PLANS_DIR（默认 ~/.pi/plans，测试注入用）
//   PI_CONTEXT_TMUX_REGISTRY（默认 ~/.pi/agent/.pi-tmux-registry.json，测试注入用）
const ABSOLUTE_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 256_000
})()
const RESTART_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_RESTART_TOKENS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 100_000
})()
const IDLE_MS = (() => {
  const raw = process.env.PI_CONTEXT_IDLE_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 600_000
})()
const TASK_GATE = process.env.PI_CONTEXT_TASK_GATE !== "off"
const PLANS_DIR =
  process.env.PI_CONTEXT_PLANS_DIR ?? join(homedir(), ".pi", "plans")
/** 最近一条用户消息时间戳（context 事件捕获；0=尚无用户消息） */
let lastUserTs = 0
/** 最近一次自动压缩时间戳（session_start 恢复二次压缩冷却用，审计 LOW） */
let lastCompactTs = 0
/** 恢复路径压缩冷却窗：距上次压缩小于该值时 session_start 不再立即二次压缩 */
const COMPACT_COOLDOWN_MS = 10 * 60_000
// ── 空闲/任务门（2026-08-24 用户策略）──
// 门2a：任务已完成或阶段性完成（无 in_progress）；门2b：本会话（PI_SESSION_ID）
// 发起的 pi-tmux 后台会话已全部退出；门3：距「任务完成点」或「最后一次用户操作」
// 较晚者连续 IDLE_MS 无用户操作。
/** 上次任务门判定是否有进行中任务（null=本进程首次，不产生完成点） */
let taskBusyPrev: boolean | null = null
/** 最近一次「有任务 → 无任务」切换时刻（0=未发生，空闲窗退化到用户消息窗） */
let taskDoneAt = 0
/** 本会话后台任务 registry 路径（pi-tmux 持久化；测试经 PI_CONTEXT_TMUX_REGISTRY 注入） */
function tmuxRegistryPath(): string {
  return (
    process.env.PI_CONTEXT_TMUX_REGISTRY ||
    join(process.env.PI_HOME || homedir(), ".pi", "agent", ".pi-tmux-registry.json")
  )
}
/** 门2b：本会话产生的后台任务（registry 中 owner=本会话 id 的条目，tmux 仍存活）。
 *  tmux 缺失/无匹配条目/进程无 PI_SESSION_ID 时宽容返回 false（不阻塞压缩）。 */
function hasBackgroundTask(): boolean {
  try {
    const regPath = tmuxRegistryPath()
    if (!existsSync(regPath)) return false
    const reg = JSON.parse(readFileSync(regPath, "utf8")) as {
      sessions?: Record<string, { owner?: string; name?: string }>
    }
    const owner = process.env.PI_SESSION_ID || ""
    if (!owner) return false
    const names: string[] = []
    for (const e of Object.values(reg.sessions ?? {})) {
      if (e.owner === owner && e.name) names.push(e.name)
    }
    if (names.length === 0) return false
    let out = ""
    try {
      const r = spawnSync("tmux", ["list-sessions"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      // tmux 命令缺失/无 server（exit≠0）→ 视为无存活后台任务，宽容放行
      if (r.error || r.status !== 0) return false
      out = String(r.stdout)
    } catch {
      return false
    }
    return names.some((n) => out.split("\n").some((l) => l.startsWith(`${n}:`)))
  } catch {
    return false
  }
}
/** 门2+门3 合并判定（2026-08-24 用户策略）：任务未完成/有后台任务/空闲窗未到 → false */
function taskAndIdleClear(): boolean {
  const busy = hasInProgressTask()
  // 先记 prev 消除忙碌窗口：有→无切换打点须在任何提前 return 前完成
  if (taskBusyPrev === true && !busy) taskDoneAt = Date.now()
  taskBusyPrev = busy
  if (busy) return false // 门2a：任务进行中
  if (hasBackgroundTask()) return false // 门2b：本会话后台任务在跑
  if (IDLE_MS <= 0) return true
  const ref = Math.max(lastUserTs, taskDoneAt)
  if (ref <= 0) return true
  return Date.now() - ref >= IDLE_MS // 门3：任务完成后/最后操作后 10 分钟内无操作
}
/** 任务门：最新（7 天内）计划文件存在 in_progress（`- [~]`）即视为有进行中任务 */
function hasInProgressTask(): boolean {
  if (!TASK_GATE) return false
  try {
    const dirs = readdirSync(PLANS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("plan-"))
      .map((d) => ({ name: d.name, ts: Number(d.name.replace("plan-", "")) }))
      .filter((d) => Number.isFinite(d.ts) && Date.now() - d.ts < 7 * 24 * 3600e3)
      .sort((a, b) => b.ts - a.ts)
    // 任务门：最新（7 天内）计划文件存在 in_progress（`- [~]`）即视为有进行中任务。
    // 审计 M4（2026-08-24）：只以最新计划目录判定——原实现遍历全部 plan-* 目录，
    // 任一历史项目/旧会话遗留的 in_progress 标记即永久阻塞当前会话自动压缩。
    const latest = dirs.length > 0 ? dirs[0] : null
    if (!latest) return false
    const content = readFileSync(join(PLANS_DIR, latest.name, "plan.md"), "utf8")
    return /^\- \[~\]/m.test(content)
  } catch (e) {
    // 无计划文件/解析失败 → 视为无进行中任务
    console.error("pi-context: task-gate read failed:", (e as Error).message);
  }
  return false
}

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
		// 用户策略：绝对阈值 256K（覆盖窗口比例）
		absoluteTokens: ABSOLUTE_TOKENS,
	});


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
		// 空闲门：捕获最后一条用户消息时间戳（pi Message.timestamp）
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const m = event.messages[i] as { role?: string; timestamp?: number };
			if (m.role === "user" && typeof m.timestamp === "number") {
				lastUserTs = m.timestamp;
				break;
			}
		}
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
		// 保护带：最近 2 轮 + 120K token 内保留（PRUNE_PROTECT_TOKENS），更早的旧工具输出替换为占位；
		// 回收 <80K 不应用（PRUNE_MINIMUM_TOKENS）。⚠ 机制真相（2026-08-15 实测）：
		// 擦除本身改变消息序列 → 发送序列 ≠ 上一轮 → DeepSeek 前缀缓存从擦除点断裂全量重发，
		// 不存在"缓存前缀稳定"。故保护带调至 120K（对齐 append-only 不动老消息哲学）：
		// 普通会话全程不触发、清理职责让给 auto-compact（一次性断裂），擦除仅作极长会话底线保障。
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

		// thinking 保留：不再每轮剪枝（2026-08-22 实测根因：max 档位单轮 thinking
		// 18-20K，64K 预算仅容 ~3 轮 → 每轮必剪最老 thinking 块 → 前缀每轮改写 →
		// A 类全断重发（会话 63% 命中、浪费 ~590 万 tokens）。对齐 append-only
		// 原则：清理职责让给 auto-compact（一次性断裂），thinking 由 compact 摘要化，
		// 无需 post-hoc 剪枝。pruneThinkingBudget 保留在 lib/prune.ts（含测试），
		// 仅作未来 compact 后可选兜底，context 阶段不再调用。
		// 思考量记账（task #14 量化）：provider（opencode-go）不返回 reasoning，
		// 须从消息层统计当轮上下文内 assistant thinking 块 token 总量（改写后=实际携带）。
		// 写 usage-diag thinking-meter，供 usage-stats --thinking 按会话聚合对照档位变化。
		let thinkingTokens = 0;
		for (const m of messages as unknown as PruneMessage[]) {
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content as { type?: string; thinking?: string }[]) {
				if (b && b.type === "thinking" && typeof b.thinking === "string") {
					thinkingTokens += estimateTokens(b.thinking);
				}
			}
		}
		recordThinkingMeter(thinkingTokens);
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
		// 无条件记录工具调用（跨设备事件日志）：provider 无 per-call usage 回传也能记。
		// outputTokens 用 estimateTokens 对输出正文估算兜底，保证始终有量。
		runToolCount += 1;
		recordToolCall({
			tool: event.toolName,
			outputTokens: estimateTokens(typeof event.content === "string" ? event.content : ""),
			input: typeof usage?.input === "number" ? usage.input : undefined,
			cacheRead: typeof usage?.cacheRead === "number" ? usage.cacheRead : undefined,
		});
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
		lastUsageSnap = { input, cacheRead, output: usage.output || 0 };
		userSeq += 1;
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
		lastLevelSwitched = false;
		// 工具事件聚合 + 30 天保留（节流 ≥60s 一次；prune 无删除不写盘，开销低）：
		// 拉取远端事件文件后（git pull）这里会自然合并进聚合，不依赖单独同步步骤。
		try {
			const now = Date.now();
			if (now - lastToolRecomputeTs > 60_000) {
				lastToolRecomputeTs = now;
				pruneToolEvents();
				recomputeToolUsage();
			}
		} catch {
			// 统计失败不阻塞主流程
		}
		const resolved = resolveContext(ctx);
		if (resolved) {
			// thinking 档位自适应（task #25）：按真实 tokens/window 比例自动升降档，
			// 每次切换强制 recordLevelChange 记账；切换后思考量变化由 thinking-meter 持续关联。
			// 用真实比例（不用 context-budget 的单调 used）：压缩后回落才能触发升回。
			// 档位压力基准对齐自动压缩阈值（~256K）而非模型窗口（1M）：对 1M 窗口，
			// 0.95 降档需 950K 永不可达，自动降档（防 thinking 剪枝核心）会成死代码（审计 M2）。
			// 改按压缩阈值比例后，接近压缩点前即可触发降档，压缩后回落自然触发升回。
			const compactT = computeCompactThreshold(resolved.window, { absoluteTokens: ABSOLUTE_TOKENS });
			const ratio = compactT && compactT > 0 ? resolved.tokens / compactT : resolved.tokens / resolved.window;
			if (!thinkState && typeof pi.getThinkingLevel === "function") {
				thinkState = createState(pi.getThinkingLevel());
			}
			if (thinkState && typeof pi.setThinkingLevel === "function") {
				try {
					lastLevelSwitched = tickThinkingLevel(thinkState, ratio, (l) => pi.setThinkingLevel(l)) !== null;
				} catch {
					// 切档失败不阻塞主流程
				}
			}
		}

		// 任务完成即时记录（task #26）：在进入压缩决策各出口前统一收口，
		// 零 LLM、确定性写 task-records.jsonl（供总结层 scripts/task-summarizer.mjs 聚合）。
		const recTask = (compacted: boolean) => {
			try {
				recordTaskRecord({
					userRequest: lastContextMessages ? extractUserRequest(lastContextMessages) : "",
					contextTokens: lastUsageSnap.cacheRead + lastUsageSnap.input,
					cacheHit: lastUsageSnap.cacheRead,
					output: lastUsageSnap.output,
					tools: runToolCount,
					compacted,
					levelChanged: lastLevelSwitched,
					userSeq,
				});
				runToolCount = 0;
			} catch {
				// 记录失败不阻塞
			}
		};
		if (!resolved) {
			recTask(false);
			return;
		}
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
					lastCompactTs = Date.now();
					markCompacted();
				},
				onError: (err) => {
					autoContinueGate.disarm();
					console.error("pi-context: overflow compact failed:", err);
				},
			});
			return recTask(true);
		}

		const decision = compactDecider.decide(tokens, contextWindow);
		if (!decision.shouldCompact) return recTask(false);
		// 三重门限（用户策略 2026-08-24）：tokens>绝对阈值已由 decide 判定，
		// 再要求 任务已完成/阶段性完成 + 本会话无后台任务 + 任务完成后/最后操作后
		// 连续 10 分钟无用户操作，全部满足才压缩。
		if (!taskAndIdleClear()) return recTask(false);

		// 压缩前原文快照（可逆追溯，零缓存影响）
		snapshotBeforeCompact(tokens, decision.threshold);
		autoContinueGate.arm();
		ctx.compact({
			// 仅压缩成功后记账/记时：cooldown 起点取真实完成时刻；
			// 失败不进入 cooldown，下一轮 agent_settled 可重试
			onComplete: () => {
				recordAutoCompact(tokens, decision.threshold);
				compactDecider.markCompact();
				lastCompactTs = Date.now();
				markCompacted();
			},
			onError: (err) => {
				autoContinueGate.disarm();
				// 压缩失败不致命：内置 96.7 万兜底仍在
				console.error("pi-context: auto-compact failed:", err);
			},
		});
		recTask(true);
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
	// 阈值：重启/恢复场景 100K（RESTART_TOKENS，见上方 startThreshold 注释）。
	// 重启/恢复后首轮必然全量重发，达阈值先压比直接重发省钱（对齐 dsh
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

		// 重启/恢复阈值：100K（PI_CONTEXT_RESTART_TOKENS 覆盖）——看门狗 3 小时
		// 自动重启后首轮必然全量重发且未命中按全价，>100K 即提前压缩（2026-08-22 用户追加）；
		// 常规 agent_settled 仍按绝对 256K + 三重门
		const startThreshold = RESTART_TOKENS;
		if (tokens < startThreshold) return;
		// 冷却（审计 LOW）：距上次压缩 <10min 的恢复不再立即二次压缩，
		// 避免恢复/重启流程连续触发两轮压缩的开销
		if (Date.now() - lastCompactTs < COMPACT_COOLDOWN_MS) return;
		// 任务已完成/阶段性完成且无后台任务、完成后超空闲窗才压缩（与 agent_settled
		// 同策略；resume 场景
		// 用户历史消息时间通常已远超空闲门；有进行中任务时不打扰）
		if (!taskAndIdleClear()) {
			// resume 不满足门限：留给首轮 agent_settled 再判定（tokens 仍大时等待）
			return;
		}

		ctx.compact({
			// 与 agent_settled 一致：成功后才记账/记时
			onComplete: () => {
				recordAutoCompact(tokens, startThreshold);
				// session_start 压缩不参与日常 decider 的 cooldown（两者独立）
				lastCompactTs = Date.now();
				markCompacted();
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

	// 混合方案（task #25 扩展）：模型主动切档，经 thinking-level 规则审批（死区+方向），
	// 通过后强制 recordLevelChange(source=model) 落盘。供特殊任务（复杂推理/长代码审查等）
	// 模型申请升降档；常规自动切档仍由 agent_settled 规则驱动。
	pi.registerTool({
		name: "thinking_level",
		label: "调整思考档位（模型建议·规则审批）",
		description:
			"建议切换 thinking 档位（low/medium/high）。程序会做防抖死区与压力方向审批：死区内或与当前上下文压力冲突时会拒绝；通过后强制记账 level-change(source=model)。默认由程序自动切档，本工具供模型在需要更强/更省推理时主动申请升降档。",
		parameters: {
			type: "object",
			properties: {
				level: {
					type: "string",
					enum: LEVEL_LADDER as unknown as string[],
					description: "目标档位（low/medium/high）",
				},
				reason: {
					type: "string",
					description: "切换理由（将记入审计日志）",
				},
			},
			required: ["level", "reason"],
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			if (!thinkState && typeof pi.getThinkingLevel === "function") {
				thinkState = createState(pi.getThinkingLevel());
			}
			if (!thinkState || typeof pi.setThinkingLevel !== "function") {
				return {
					content: [{ type: "text", text: "档位状态未就绪或内核不支持 setThinkingLevel。" }],
					isError: true,
					details: null,
				};
			}
			const level = params?.level as string | undefined;
			const reason = typeof params?.reason === "string" ? params.reason : "";
			if (!level) {
				return {
					content: [{ type: "text", text: "缺少 level 参数（low/medium/high）" }],
					isError: true,
					details: null,
				};
			}
			const r = proposeThinkingLevel(thinkState, level, reason, (l) => pi.setThinkingLevel(l));
			return {
				content: [{ type: "text", text: r.message }],
				isError: !r.ok,
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
			const threshold = computeCompactThreshold(resolved.window, { absoluteTokens: ABSOLUTE_TOKENS });
			setContextWindow(resolved.window);
			setUsedTokens(resolved.tokens); // 真实用量校准：plan-mode 等共享库消费者压力提示随之准确
			setCompactThreshold(threshold ?? 0); // 压缩阈值为 pressure 分母（审计 M3：1M 窗口下 850K 不可达会哑火）
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
