import { recordAutoCompact, recordUsage, pruneToolEvents, recomputeToolUsage } from "./diagnostics.ts";
import { recordTaskRecord } from "../../lib/task-record.ts";
import { extractUserRequest } from "./message-utils.ts";
import { inferTaskType } from "./thinking-level.ts";
import { markCompacted } from "../../lib/context-budget.ts";
import { snapshotBeforeCompact } from "./compression.ts";
import { makeAutoContinueGate, makeCompactDecider } from "../../lib/auto-compact.ts";
import { readAdminStateAction } from "./admin-state.ts";
import { resolveContext } from "./context-resolver.ts";
import { sweepPruneRefs } from "../../lib/prune.ts";
import { PRUNE_REFS_DIR, PRUNE_REFS_RETENTION_DAYS } from "./prune-dump.ts";
import {
  ABSOLUTE_TOKENS,
  RESTART_TOKENS,
  COMPACT_COOLDOWN_MS,
  hasInProgressTask,
  hasBackgroundTask,
  IDLE_MS,
} from "./task-gate.ts";
import { readEnvRatio } from "./context-resolver.ts";
import type { WarmPrefixState } from "./warm-prefix-replay.ts";
import type { ToolLifecycleState } from "./tool-lifecycle.ts";
import type { MessageFilterState } from "./message-filtering.ts";

export interface AutoCompactState {
  lastCompactTs: number;
  lastProviderContextTokens: number;
  fallbackContextWindow: number;
  lastLevelSwitched: boolean;
  userSeq: number;
  lastUsageSnap: { input: number; cacheRead: number; output: number };
  taskBusyPrev: boolean | null;
  taskDoneAt: number;
}

export function createAutoCompactState(): AutoCompactState {
  return {
    lastCompactTs: 0,
    lastProviderContextTokens: 0,
    fallbackContextWindow: (() => {
      const raw = process.env.PI_CONTEXT_WINDOW_FALLBACK;
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 1_000_000;
    })(),
    lastLevelSwitched: false,
    userSeq: 0,
    lastUsageSnap: { input: 0, cacheRead: 0, output: 0 },
    taskBusyPrev: null,
    taskDoneAt: 0,
  };
}

export function registerAutoCompactController(
  pi: any,
  acState: AutoCompactState,
  warmState: WarmPrefixState,
  toolState: ToolLifecycleState,
  msgState: MessageFilterState,
  thinkStateRef: { current: any },
  piSetThinkingLevel?: (l: string) => void,
  piGetThinkingLevel?: () => string,
): void {
  const compactDecider = makeCompactDecider(undefined, {
    largeRatio: readEnvRatio("PI_CONTEXT_COMPACT_LARGE_RATIO"),
    smallRatio: readEnvRatio("PI_CONTEXT_COMPACT_SMALL_RATIO"),
    absoluteTokens: ABSOLUTE_TOKENS,
  });
  const autoContinueGate = makeAutoContinueGate();

  // turn_end 用量记录
  pi.on("turn_end", (event: any) => {
    const usage = (event.message as { usage?: any } | undefined)?.usage;
    if (!usage || typeof usage.input !== "number") return;
    const input = usage.input || 0;
    const cacheRead = usage.cacheRead || 0;
    const contextTokens = input + cacheRead;
    acState.lastProviderContextTokens = contextTokens;
    acState.lastUsageSnap = { input, cacheRead, output: usage.output || 0 };
    acState.userSeq += 1;
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
  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    const userRequest = extractUserRequest(msgState.lastContextMessages ?? []);
    const taskType = inferTaskType(userRequest);
    acState.lastLevelSwitched = false;
    try {
      const now = Date.now();
      if (now - toolState.lastToolRecomputeTs > 60_000) {
        toolState.lastToolRecomputeTs = now;
        pruneToolEvents();
        recomputeToolUsage();
      }
    } catch {
      // 统计失败不阻塞主流程
    }
    const resolved = resolveContext(ctx, acState.lastProviderContextTokens, acState.fallbackContextWindow);
    if (resolved) {
      const ratio = resolved.tokens / resolved.window;
      if (!thinkStateRef.current && typeof piGetThinkingLevel === "function") {
        const { createState } = require("./thinking-level.ts");
        thinkStateRef.current = createState(piGetThinkingLevel());
      }
      if (thinkStateRef.current && typeof piSetThinkingLevel === "function") {
        try {
          const { tickThinkingLevel } = require("./thinking-level.ts");
          acState.lastLevelSwitched = tickThinkingLevel(thinkStateRef.current, ratio, piSetThinkingLevel, undefined, taskType) !== null;
        } catch {
          // 切档失败不阻塞主流程
        }
      }
    }

    const recTask = (compacted: boolean) => {
      try {
        recordTaskRecord({
          userRequest: msgState.lastContextMessages ? extractUserRequest(msgState.lastContextMessages) : "",
          contextTokens: acState.lastUsageSnap.cacheRead + acState.lastUsageSnap.input,
          cacheHit: acState.lastUsageSnap.cacheRead,
          output: acState.lastUsageSnap.output,
          tools: toolState.runToolCount,
          compacted,
          levelChanged: acState.lastLevelSwitched,
          userSeq: acState.userSeq,
        });
        toolState.runToolCount = 0;
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
      snapshotBeforeCompact(msgState.lastContextMessages, tokens, contextWindow, "overflow");
      autoContinueGate.arm();
      ctx.compact({
        customInstructions:
          "上下文已接近/超过模型窗口。请生成结构化摘要，并显式丢弃早期工具输出细节，保留关键决策、文件路径与待办。",
        onComplete: () => {
          recordAutoCompact(tokens, contextWindow);
          compactDecider.markCompact();
          acState.lastCompactTs = Date.now();
          markCompacted();
          recTask(true);
        },
        onError: (err: unknown) => {
          autoContinueGate.disarm();
          console.error("pi-context: overflow compact failed:", err);
          recTask(false);
        },
      });
      return;
    }

    const decision = compactDecider.decide(tokens, contextWindow);
    if (!decision.shouldCompact) return recTask(false);

    // 门2+门3 合并判定
    const busy = hasInProgressTask();
    if (acState.taskBusyPrev === true && !busy) acState.taskDoneAt = Date.now();
    acState.taskBusyPrev = busy;
    if (busy) return recTask(false);
    if (hasBackgroundTask()) return recTask(false);
    if (IDLE_MS > 0) {
      const ref = Math.max(msgState.lastUserTs, acState.taskDoneAt);
      if (ref > 0 && Date.now() - ref < IDLE_MS) return recTask(false);
    }

    snapshotBeforeCompact(msgState.lastContextMessages, tokens, decision.threshold);
    autoContinueGate.arm();
    ctx.compact({
      onComplete: () => {
        recordAutoCompact(tokens, decision.threshold);
        compactDecider.markCompact();
        acState.lastCompactTs = Date.now();
        markCompacted();
        recTask(true);
      },
      onError: (err: unknown) => {
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
  pi.on("session_start", (_event: any, ctx: any) => {
    if (_event.reason === "new" || _event.reason === "fork") acState.lastProviderContextTokens = 0;
    void sweepPruneRefs(PRUNE_REFS_DIR, { retentionDays: PRUNE_REFS_RETENTION_DAYS }).catch(() => {});
    const resolved = resolveContext(ctx, acState.lastProviderContextTokens, acState.fallbackContextWindow);
    if (!resolved) return;
    const { tokens, window: contextWindow } = resolved;

    const startThreshold = RESTART_TOKENS;
    if (tokens < startThreshold || readAdminStateAction() !== "restart_hang") return;
    if (Date.now() - acState.lastCompactTs < COMPACT_COOLDOWN_MS) return;

    // 门2+门3
    const busy = hasInProgressTask();
    if (acState.taskBusyPrev === true && !busy) acState.taskDoneAt = Date.now();
    acState.taskBusyPrev = busy;
    if (busy) return;
    if (hasBackgroundTask()) return;
    if (IDLE_MS <= 0 || Math.max(msgState.lastUserTs, acState.taskDoneAt) <= 0) {
      // 空闲检查通过
    } else if (Date.now() - Math.max(msgState.lastUserTs, acState.taskDoneAt) < IDLE_MS) {
      return;
    }

    ctx.compact({
      onComplete: () => {
        recordAutoCompact(tokens, startThreshold);
        acState.lastCompactTs = Date.now();
        markCompacted();
      },
      onError: (err: unknown) => {
        console.error("pi-context: resume compact failed:", err);
      },
    });
  });
}
