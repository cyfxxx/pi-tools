import { pruneToolResults, type PruneMessage } from "../../lib/prune.ts";
import { estimateTokens } from "../../lib/context-budget.ts";
import { buildPruneDumpRef, PRUNE_REFS_DIR, PRUNE_REFS_RETENTION_DAYS } from "./prune-dump.ts";
import { sweepPruneRefs } from "../../lib/prune.ts";

const DIAG_CUSTOM_TYPES = new Set(["usage-diag"]);

export interface MessageFilterState {
  lastContextMessages: unknown[] | null;
  lastUserTs: number;
}

export function createMessageFilterState(): MessageFilterState {
  return { lastContextMessages: null, lastUserTs: 0 };
}

export function registerMessageFilter(
  pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void },
  state: MessageFilterState,
): void {
  // R2/R3：context 阶段确定性过滤
  pi.on("context", (event: any, ctx: any) => {
    state.lastContextMessages = event.messages;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i] as { role?: string; timestamp?: number };
      if (m.role === "user" && typeof m.timestamp === "number") {
        state.lastUserTs = m.timestamp;
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
}
