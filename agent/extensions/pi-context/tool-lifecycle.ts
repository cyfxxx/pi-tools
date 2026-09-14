import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateTokens, recordCacheUsage } from "../../lib/context-budget.ts";
import { recordToolCall, recordToolUsage } from "./diagnostics.ts";
import { truncateToolContent, updateFailStreak } from "./tool-truncation.ts";

export interface ToolLifecycleState {
  toolCallStarts: Map<string, number>;
  failStreak: Map<string, number>;
  runToolCount: number;
  lastToolRecomputeTs: number;
}

export function createToolLifecycleState(): ToolLifecycleState {
  return {
    toolCallStarts: new Map(),
    failStreak: new Map(),
    runToolCount: 0,
    lastToolRecomputeTs: 0,
  };
}

function toolContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
  }
  return "";
}

export function registerToolLifecycle(
  pi: ExtensionAPI,
  state: ToolLifecycleState,
  maxToolBytes: number,
  maxOtherToolBytes: number,
): void {
  // 工具调用结构化记录
  pi.on("tool_call", (event: { toolName?: string; arguments?: unknown }) => {
    if (event.toolName) {
      state.toolCallStarts.set(event.toolName, Date.now());
    }
  });

  // R4：工具输出截断 + 连续失败熔断
  pi.on("tool_result", (event: ToolResultEvent) => {
    const cap = event.toolName === "bash" || event.toolName === "read" ? maxToolBytes : maxOtherToolBytes;
    const truncated = truncateToolContent(event.toolName, event.content, cap);
    let content = truncated ? truncated.content : event.content;
    let hint: string | undefined;
    if (event.isError) {
      hint = updateFailStreak(state.failStreak, event.toolName, true).hint;
    } else {
      updateFailStreak(state.failStreak, event.toolName, false);
    }
    const startMs = state.toolCallStarts.get(event.toolName);
    if (startMs) {
      state.toolCallStarts.delete(event.toolName);
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
  pi.on("tool_result", (event: ToolResultEvent) => {
    const usage: Usage | undefined = event.usage;
    state.runToolCount += 1;
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
}

// re-export recordToolCallEvent from diagnostics for use above
import { recordToolCallEvent } from "./diagnostics.ts";
