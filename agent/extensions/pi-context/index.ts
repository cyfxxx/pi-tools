import { type ExtensionAPI, type ToolResultEvent, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  setContextWindow,
  setUsedTokens,
  markCompacted,
  recordCacheUsage,
  estimateTokens,
} from "../../lib/context-budget.ts";
import { computeCompactThreshold, makeAutoContinueGate, makeCompactDecider } from "../../lib/auto-compact.ts";
import { pruneToolResults, sweepPruneRefs, type PruneMessage } from "../../lib/prune.ts";
import {
  createState,
  tickThinkingLevel,
  proposeThinkingLevel,
  LEVEL_LADDER,
  inferTaskType,
  type ThinkLevelState,
  type TaskType,
} from "./thinking-level.ts";
import { recordTaskRecord } from "../../lib/task-record.ts";
import { diag, recordAutoCompact, recordToolCall, recordToolCallEvent, recordToolEnable, recordToolUsage, recordUsage, pruneToolEvents, recomputeToolUsage } from "./diagnostics.ts";
import { truncateToolContent, updateFailStreak } from "./tool-truncation.ts";
import { snapshotBeforeCompact } from "./compression.ts";
import { enabledGroups, applyToolLayering, buildToolsReport, buildSleepingSummary } from "./tool-layering.ts";

// ── 擦除溯源 refs（借鉴 TencentDB-Agent-Memory 的 refs 卸载 + Reclaimer 清理）──
const PRUNE_REFS_DIR = join(homedir(), ".pi", "logs", "prune-refs");
const PRUNE_REFS_RETENTION_DAYS = 14;

type PruneDumpCtx = { sessionManager?: { getSessionId?: () => string | null | undefined } };

/** 构造擦除落盘回调 */
function buildPruneDumpRef(ctx: PruneDumpCtx | undefined) {
  let sessionId = "adhoc";
  try {
    sessionId = String(ctx?.sessionManager?.getSessionId?.() || "adhoc");
  } catch {
    // 取不到会话身份时退化为共享文件
  }
  const file = join(PRUNE_REFS_DIR, `${sessionId}.md`);
  let dirReady = false;
  let seq = 0;
  return (text: string, meta: { index: number; chars: number }): string | null => {
    if (text.includes("[pruned:")) return null;
    if (!dirReady) {
      mkdirSync(PRUNE_REFS_DIR, { recursive: true });
      dirReady = true;
    }
    seq++;
    const { appendFileSync } = require("node:fs");
    appendFileSync(
      file,
      `\n## 擦除条目 e${seq} · ${new Date().toISOString()} · 消息#${meta.index} · ${meta.chars} 字符\n\n${text}\n`,
      "utf8",
    );
    return file;
  };
}

// 执行效率指令（静态注入，缓存友好）
export const EFFICIENCY_ADVICE = `## Execution Efficiency

- Independent tool calls (multiple reads, greps, globs) MUST be issued in a single assistant turn — batch them together; a parallel batch costs only one request.
- During exploration/execution turns, do NOT write explanatory text or progress reports — output tool calls only. Summarize once when everything is done.
- Exception: when todo progress updates are required or a plan summary is requested, output the required structured summary.
- Long exploration dead-ends: if multiple reads/greps yield no conclusion, delegate exploration to subagent (scout) to keep the main context clean.`;

/**
 * 低压力精简版委托建议（静态注入，缓存友好）
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

// 重启来源判定
const ADMIN_STATE_FILE =
  process.env.PI_CONTEXT_ADMIN_STATE || join(homedir(), ".pi", "agent", ".pi-admin-state.json");
function readAdminStateAction(): string {
  try {
    const raw = readFileSync(ADMIN_STATE_FILE, "utf-8");
    const s = JSON.parse(raw) as { action?: string };
    return typeof s.action === "string" ? s.action : "none";
  } catch {
    return "none";
  }
}

/** context hook 最近一次拿到的 messages */
let lastContextMessages: unknown[] | null = null;
// thinking 档位自适应状态
let thinkState: ThinkLevelState | null = null;
// 任务完成即时记录
let runToolCount = 0;
let lastToolRecomputeTs = 0;
let lastUsageSnap: { input: number; cacheRead: number; output: number } = { input: 0, cacheRead: 0, output: 0 };
let userSeq = 0;
let lastLevelSwitched = false;

/** 从上下文消息提取最后一条实质 user 请求 */
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

// ── 上下文解析 fallback ──
const FALLBACK_CONTEXT_WINDOW = 1_000_000;
let fallbackContextWindow = (() => {
  const raw = process.env.PI_CONTEXT_WINDOW_FALLBACK;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_CONTEXT_WINDOW;
})();
/** 最近一轮 provider 报告的 contextTokens */
let lastProviderContextTokens = 0;

// ── 压缩三重门限 ──
const ABSOLUTE_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 256_000;
})();
const RESTART_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_RESTART_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();
const IDLE_MS = (() => {
  const raw = process.env.PI_CONTEXT_IDLE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
})();
const TASK_GATE = process.env.PI_CONTEXT_TASK_GATE !== "off";
const PLANS_DIR =
  process.env.PI_CONTEXT_PLANS_DIR ?? join(homedir(), ".pi", "plans");
/** 最近一条用户消息时间戳 */
let lastUserTs = 0;
/** 最近一次自动压缩时间戳 */
let lastCompactTs = 0;
/** 恢复路径压缩冷却窗 */
const COMPACT_COOLDOWN_MS = 10 * 60_000;
// ── 空闲/任务门 ──
let taskBusyPrev: boolean | null = null;
let taskDoneAt = 0;

/** 本会话后台任务 registry 路径 */
function tmuxRegistryPath(): string {
  return (
    process.env.PI_CONTEXT_TMUX_REGISTRY ||
    join(process.env.PI_HOME || homedir(), ".pi", "agent", "extensions", "pi-tmux", ".pi-tmux-registry.json")
  );
}

/** 门2b：本会话产生的后台任务 */
function hasBackgroundTask(): boolean {
  try {
    const regPath = tmuxRegistryPath();
    if (!existsSync(regPath)) return false;
    const reg = JSON.parse(readFileSync(regPath, "utf8")) as {
      sessions?: Record<string, { owner?: string; name?: string }>
    };
    const owner = process.env.PI_SESSION_ID || "";
    if (!owner) return false;
    const names: string[] = [];
    for (const e of Object.values(reg.sessions ?? {})) {
      if (e.owner === owner && e.name) names.push(e.name);
    }
    if (names.length === 0) return false;
    let out = "";
    try {
      const r = spawnSync("tmux", ["list-sessions"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r.error || r.status !== 0) return false;
      out = String(r.stdout);
    } catch {
      return false;
    }
    return names.some((n) => out.split("\n").some((l) => l.startsWith(`${n}:`)));
  } catch {
    return false;
  }
}

/** 门2+门3 合并判定 */
function taskAndIdleClear(): boolean {
  const busy = hasInProgressTask();
  if (taskBusyPrev === true && !busy) taskDoneAt = Date.now();
  taskBusyPrev = busy;
  if (busy) return false;
  if (hasBackgroundTask()) return false;
  if (IDLE_MS <= 0) return true;
  const ref = Math.max(lastUserTs, taskDoneAt);
  if (ref <= 0) return true;
  return Date.now() - ref >= IDLE_MS;
}

/** 任务门 */
function hasInProgressTask(): boolean {
  if (!TASK_GATE) return false;
  try {
    const dirs = readdirSync(PLANS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("plan-"))
      .map((d) => ({ name: d.name, ts: Number(d.name.replace("plan-", "")) }))
      .filter((d) => Number.isFinite(d.ts) && Date.now() - d.ts < 7 * 24 * 3600e3)
      .sort((a, b) => b.ts - a.ts);
    const latest = dirs.length > 0 ? dirs[0] : null;
    if (!latest) return false;
    const content = readFileSync(join(PLANS_DIR, latest.name, "plan.md"), "utf8");
    return /^\- \[~\]/m.test(content);
  } catch (e) {
    console.error("pi-context: task-gate read failed:", (e as Error).message);
  }
  return false;
}

/** 读取 0-1 比例环境变量 */
function readEnvRatio(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}

interface ResolvedContext {
  tokens: number;
  window: number;
}

/** 解析会话上下文信息 */
function resolveContext(ctx: { getContextUsage?: () => unknown }): ResolvedContext | null {
  const usage = ctx.getContextUsage?.() as
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined;
  if (
    usage &&
    typeof usage.tokens === "number" &&
    usage.tokens > 0 &&
    typeof usage.contextWindow === "number" &&
    usage.contextWindow > 0
  ) {
    return { tokens: usage.tokens, window: usage.contextWindow };
  }
  if (lastProviderContextTokens > 0) {
    return { tokens: lastProviderContextTokens, window: fallbackContextWindow };
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  const MAX_TOOL_BYTES = 5000;
  const MAX_OTHER_TOOL_BYTES = 20 * 1024;
  const compactDecider = makeCompactDecider(undefined, {
    largeRatio: readEnvRatio("PI_CONTEXT_COMPACT_LARGE_RATIO"),
    smallRatio: readEnvRatio("PI_CONTEXT_COMPACT_SMALL_RATIO"),
    absoluteTokens: ABSOLUTE_TOKENS,
  });

  const autoContinueGate = makeAutoContinueGate();
  const DIAG_CUSTOM_TYPES = new Set(["usage-diag"]);

  // ── 暖前缀重放 ──
  let lastModelKey = "";
  const AUTO_PREFIX_CACHE_RE = /deepseek|qwen|kimi|moonshot|glm|zhipu|doubao|gemini|gpt-|o[134]-/i;
  const CONV_TAG_RE = /<conversation>/;
  let lastRequestPayload: { messages: unknown[]; tools?: unknown } | null = null;

  pi.on("before_provider_request", async (event) => {
    try {
      if (!AUTO_PREFIX_CACHE_RE.test(lastModelKey)) return undefined;
      const payload = event.payload as {
        messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
        tools?: unknown;
      };
      const msgs = payload?.messages;
      if (!Array.isArray(msgs) || msgs.length === 0) return undefined;
      const last = msgs[msgs.length - 1];
      const lastText =
        typeof last.content === "string"
          ? last.content
          : Array.isArray(last.content)
            ? last.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n")
            : "";
      const isSummarization = last.role === "user" && CONV_TAG_RE.test(lastText);
      if (!isSummarization) {
        lastRequestPayload = {
          messages: structuredClone(msgs),
          tools: payload.tools !== undefined ? structuredClone(payload.tools) : undefined,
        };
        diag("saved-main", { msgs: msgs.length, tools: payload.tools !== undefined });
        return undefined;
      }
      if (!lastRequestPayload || lastRequestPayload.messages.length === 0) {
        diag("no-main-saved");
        return undefined;
      }
      const tail = lastText.replace(/^<conversation>\n[\s\S]*?\n<\/conversation>\n\n/, "");
      if (tail === lastText || !tail.trim()) {
        diag("tail-extract-failed", { len: tail.length });
        return undefined;
      }
      const next = {
        ...payload,
        messages: [...lastRequestPayload.messages, { role: "user", content: tail }],
      } as Record<string, unknown>;
      if (lastRequestPayload.tools !== undefined) next.tools = lastRequestPayload.tools;
      diag("rewrite-summarization", {
        baseMsgs: lastRequestPayload.messages.length,
        tailLen: tail.length,
        hasTools: next.tools !== undefined,
      });
      return next as typeof event.payload;
    } catch (err) {
      diag("handler-error", { msg: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  });

  // ── 暖前缀重放 v1.5 ──
  let compactWarmAllowed = false;
  pi.on("session_before_compact", (event, ctx) => {
    const w = ctx.model?.contextWindow ?? 0;
    compactWarmAllowed =
      event.reason !== "overflow" && !(w > 0 && event.preparation.tokensBefore > w * 0.9);
  });
  (async () => {
    try {
      const piAgent = await import("@earendil-works/pi-coding-agent");
      const setCompactionWarmPrefixProvider = (piAgent as any).setCompactionWarmPrefixProvider;
      if (typeof setCompactionWarmPrefixProvider === 'function') {
        setCompactionWarmPrefixProvider(() => {
          if (!compactWarmAllowed) return null;
          if (!lastRequestPayload || lastRequestPayload.messages.length === 0) return null;
          if (!AUTO_PREFIX_CACHE_RE.test(lastModelKey)) return null;
          if (!Array.isArray(lastRequestPayload.tools) || lastRequestPayload.tools.length === 0) return null;
          return { systemPrompt: "", tools: lastRequestPayload.tools, messages: lastRequestPayload.messages };
        });
      }
    } catch {
      // 补丁未应用时静默降级
    }
  })();

  // R2/R3：context 阶段确定性过滤
  pi.on("context", (event, ctx) => {
    lastContextMessages = event.messages;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i] as { role?: string; timestamp?: number };
      if (m.role === "user" && typeof m.timestamp === "number") {
        lastUserTs = m.timestamp;
        break;
      }
    }
    let messages = event.messages;
    let modified = false;

    const filteredMessages: typeof messages = [];
    for (const m of messages) {
      const customType = m.role === "custom" ? (m as { customType?: string }).customType : undefined;
      if (customType && DIAG_CUSTOM_TYPES.has(customType)) {
        modified = true;
        continue;
      }
      filteredMessages.push(m);
    }
    if (modified) messages = filteredMessages;

    const pruned = pruneToolResults(messages as unknown as PruneMessage[], {
      dumpRef: buildPruneDumpRef(ctx),
    });
    if (pruned.modified) {
      messages = pruned.messages as unknown as typeof messages;
      modified = true;
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

    let thinkingTokens = 0;
    for (const m of messages as unknown as PruneMessage[]) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content as { type?: string; thinking?: string }[]) {
        if (b && b.type === "thinking" && typeof b.thinking === "string") {
          thinkingTokens += estimateTokens(b.thinking);
        }
      }
    }

    if (modified) return { messages };
  });

  // 工具调用结构化记录
  const toolCallStarts = new Map<string, number>();
  pi.on("tool_call", (event: { toolName?: string; arguments?: unknown }) => {
    if (event.toolName) {
      toolCallStarts.set(event.toolName, Date.now());
    }
  });

  // R4：工具输出截断 + 连续失败熔断
  const failStreak = new Map<string, number>();
  pi.on("tool_result", (event: ToolResultEvent) => {
    const cap = event.toolName === "bash" || event.toolName === "read" ? MAX_TOOL_BYTES : MAX_OTHER_TOOL_BYTES;
    const truncated = truncateToolContent(event.toolName, event.content, cap);
    let content = truncated ? truncated.content : event.content;
    let hint: string | undefined;
    if (event.isError) {
      hint = updateFailStreak(failStreak, event.toolName, true).hint;
    } else {
      updateFailStreak(failStreak, event.toolName, false);
    }
    const startMs = toolCallStarts.get(event.toolName);
    if (startMs) {
      toolCallStarts.delete(event.toolName);
      try {
        recordToolCallEvent({
          args: (event as any).args ?? {},
          tool: event.toolName,
          ok: !event.isError,
          durationMs: Date.now() - startMs,
        });
      } catch { /* 记录失败静默 */ }
    }

    if (!truncated && !hint) return;
    return {
      content: hint ? [...content, { type: "text" as const, text: hint }] : content,
      details: event.details,
    };
  });

  // 缓存命中统计
  function toolContentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
    }
    return "";
  }

  pi.on("tool_result", (event: ToolResultEvent) => {
    const usage: Usage | undefined = event.usage;
    runToolCount += 1;
    recordToolCall({
      tool: event.toolName,
      outputTokens: estimateTokens(toolContentText(event.content)),
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

  // 每轮用量记录
  pi.on("turn_end", (event: TurnEndEvent) => {
    const usage = (event.message as { usage?: Usage } | undefined)?.usage;
    if (!usage || typeof usage.input !== "number") {
      return;
    }

    const input = usage.input || 0;
    const cacheRead = usage.cacheRead || 0;
    const contextTokens = input + cacheRead;
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

  // 按窗口比例自动压缩
  pi.on("agent_settled", (_event, ctx) => {
    const userRequest = extractUserRequest(lastContextMessages ?? []);
    const taskType = inferTaskType(userRequest);
    lastLevelSwitched = false;
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
      const ratio = resolved.tokens / resolved.window;
      if (!thinkState && typeof pi.getThinkingLevel === "function") {
        thinkState = createState(pi.getThinkingLevel());
      }
      if (thinkState && typeof pi.setThinkingLevel === "function") {
        try {
          lastLevelSwitched = tickThinkingLevel(thinkState, ratio, (l) => pi.setThinkingLevel(l), undefined, taskType) !== null;
        } catch {
          // 切档失败不阻塞主流程
        }
      }
    }

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

    if (tokens >= contextWindow) {
      snapshotBeforeCompact(lastContextMessages, tokens, contextWindow, "overflow");
      autoContinueGate.arm();
      ctx.compact({
        customInstructions:
          "上下文已接近/超过模型窗口。请生成结构化摘要，并显式丢弃早期工具输出细节，保留关键决策、文件路径与待办。",
        onComplete: () => {
          recordAutoCompact(tokens, contextWindow);
          compactDecider.markCompact();
          lastCompactTs = Date.now();
          markCompacted();
          recTask(true);
        },
        onError: (err) => {
          autoContinueGate.disarm();
          console.error("pi-context: overflow compact failed:", err);
          recTask(false);
        },
      });
      return;
    }

    const decision = compactDecider.decide(tokens, contextWindow);
    if (!decision.shouldCompact) return recTask(false);
    if (!taskAndIdleClear()) return recTask(false);

    snapshotBeforeCompact(lastContextMessages, tokens, decision.threshold);
    autoContinueGate.arm();
    ctx.compact({
      onComplete: () => {
        recordAutoCompact(tokens, decision.threshold);
        compactDecider.markCompact();
        lastCompactTs = Date.now();
        markCompacted();
        recTask(true);
      },
      onError: (err) => {
        autoContinueGate.disarm();
        console.error("pi-context: auto-compact failed:", err);
        recTask(false);
      },
    });
  });

  // 压缩完成后自动继续
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

  // 会话恢复
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new" || event.reason === "fork") lastProviderContextTokens = 0;
    void sweepPruneRefs(PRUNE_REFS_DIR, { retentionDays: PRUNE_REFS_RETENTION_DAYS }).catch(() => {});
    const resolved = resolveContext(ctx);
    if (!resolved) return;
    const { tokens, window: contextWindow } = resolved;

    const startThreshold = RESTART_TOKENS;
    if (tokens < startThreshold || readAdminStateAction() !== "restart_hang") return;
    if (Date.now() - lastCompactTs < COMPACT_COOLDOWN_MS) return;
    if (!taskAndIdleClear()) {
      return;
    }

    ctx.compact({
      onComplete: () => {
        recordAutoCompact(tokens, startThreshold);
        lastCompactTs = Date.now();
        markCompacted();
      },
      onError: (err) => {
        console.error("pi-context: resume compact failed:", err);
      },
    });
  });

  // 用量诊断汇总
  pi.registerCommand("usage-diag", {
    description: "显示会话 LLM 用量诊断（每轮 input/缓存/输出汇总）",
    handler: async (_args, ctx) => {
      const { formatUsageSummary, loadDiagLines } = require("../../lib/usage-diag.ts");
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

  // ── 工具分层与按需加载 ──
  let layeringApplied = false;

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
          enum: ["browser", "admin", "autopilot", "link"],
          description: "要启用的休眠工具组名",
        },
      },
      required: ["group"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const group = params?.group as string | undefined;
      const { SLEEPING_GROUPS } = require("./tool-groups.ts");
      const g = SLEEPING_GROUPS.find((x: any) => x.name === group);
      if (!g) {
        return {
          content: [
            {
              type: "text",
              text: `未知工具组: ${group ?? "(空)"}。可用组: ${SLEEPING_GROUPS.map((x: any) => x.name).join(", ")}`,
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
      applyToolLayering(pi as any);
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

  // 工具分层管理命令
  pi.registerCommand("tools", {
    description: "工具分层：list 查看分组/状态，enable <group> 启用休眠组（见 /tools help）",
    getArgumentCompletions: (prefix) => {
      const first = (prefix?.trim().split(/\s+/)[0] ?? "").toLowerCase();
      const items = [
        { value: "list", label: "list", description: "查看分组/状态" },
        { value: "enable ", label: "enable", description: "启用休眠组（browser/admin/autopilot/link）" },
        { value: "help", label: "help", description: "显示用法" },
      ];
      if (!prefix?.includes(" ")) {
        return items.filter((i) => i.value.startsWith(first));
      }
      if (first === "enable") {
        const { SLEEPING_GROUPS } = require("./tool-groups.ts");
        return SLEEPING_GROUPS.filter((g: any) => g.name.startsWith(prefix.trim().split(/\s+/)[1] ?? "")).map((g: any) => ({
          value: "enable " + g.name,
          label: g.name,
          description: g.tools.join(", "),
        }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      if (cmd === "enable" && rest[0]) {
        const { SLEEPING_GROUPS } = require("./tool-groups.ts");
        const g = SLEEPING_GROUPS.find((x: any) => x.name === rest[0]);
        if (!g) {
          ctx.ui.notify(`未知组: ${rest[0]}。可用: ${SLEEPING_GROUPS.map((x: any) => x.name).join(", ")}`, "warning");
          return;
        }
        enabledGroups.add(g.name);
        applyToolLayering(pi as any);
        recordToolEnable(g.name, "cmd");
        ctx.ui.notify(`已启用工具组 ${g.name}（${g.tools.join(", ")}），本会话内保持。`, "info");
        return;
      }
      const content = buildToolsReport(() => (pi as any).getActiveTools());
      const { SLEEPING_GROUPS, CORE_TOOLS } = require("./tool-groups.ts");
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
  pi.on("before_agent_start", async (event, ctx) => {
    lastModelKey = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
    if (!layeringApplied) {
      applyToolLayering(pi as any);
      layeringApplied = true;
    } else {
      const cur = (pi as ExtensionAPI & { getActiveTools(): string[] }).getActiveTools();
      const { SLEEPING_GROUPS } = require("./tool-groups.ts");
      const dormant = SLEEPING_GROUPS.filter((g: any) => !enabledGroups.has(g.name)).flatMap((g: any) => g.tools);
      if (dormant.some((n: string) => cur.includes(n))) {
        applyToolLayering(pi as any);
      }
    }

    const resolved = resolveContext(ctx);
    let pressureLine = "";
    if (resolved) {
      setContextWindow(resolved.window);
      setUsedTokens(resolved.tokens);
      if (resolved.window > 0) {
        const near = resolved.tokens / resolved.window;
        if (near >= 0.9) {
          pressureLine =
            "\n\n[上下文已占窗口 90%；达到压缩条件将自动压缩并生成摘要，关键决策与待办会保留在摘要中；需精确保真的细节可先存 ctx_note。]";
        } else if (near >= 0.75) {
          pressureLine =
            "\n\n[上下文已占窗口 75%。]";
        }
      }
    }

    const delegationAdvice = pressureLine
      ? FULL_DELEGATION_ADVICE + "\n" + pressureLine
      : LOW_PRESSURE_DELEGATION;

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
