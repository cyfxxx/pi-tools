import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diag } from "./diagnostics.ts";

const AUTO_PREFIX_CACHE_RE = /deepseek|qwen|kimi|moonshot|glm|zhipu|doubao|gemini|gpt-|o[134]-/i;
const CONV_TAG_RE = /<conversation>/;

export interface WarmPrefixState {
  lastModelKey: string;
  lastRequestPayload: { messages: unknown[]; tools?: unknown } | null;
  compactWarmAllowed: boolean;
}

export function createWarmPrefixState(): WarmPrefixState {
  return { lastModelKey: "", lastRequestPayload: null, compactWarmAllowed: false };
}

export function registerWarmPrefixReplay(pi: ExtensionAPI, state: WarmPrefixState): void {
  pi.on("before_provider_request", async (event) => {
    try {
      if (!AUTO_PREFIX_CACHE_RE.test(state.lastModelKey)) return undefined;
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
        state.lastRequestPayload = {
          messages: structuredClone(msgs),
          tools: payload.tools !== undefined ? structuredClone(payload.tools) : undefined,
        };
        diag("saved-main", { msgs: msgs.length, tools: payload.tools !== undefined });
        return undefined;
      }
      if (!state.lastRequestPayload || state.lastRequestPayload.messages.length === 0) {
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
        messages: [...state.lastRequestPayload.messages, { role: "user", content: tail }],
      } as Record<string, unknown>;
      if (state.lastRequestPayload.tools !== undefined) next.tools = state.lastRequestPayload.tools;
      diag("rewrite-summarization", {
        baseMsgs: state.lastRequestPayload.messages.length,
        tailLen: tail.length,
        hasTools: next.tools !== undefined,
      });
      return next as typeof event.payload;
    } catch (err) {
      diag("handler-error", { msg: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  });

  // 暖前缀重放 v1.5
  pi.on("session_before_compact", (event, ctx) => {
    const w = ctx.model?.contextWindow ?? 0;
    state.compactWarmAllowed =
      event.reason !== "overflow" && !(w > 0 && event.preparation.tokensBefore > w * 0.9);
  });

  (async () => {
    try {
      const piAgent = await import("@earendil-works/pi-coding-agent");
      const setCompactionWarmPrefixProvider = (piAgent as any).setCompactionWarmPrefixProvider;
      if (typeof setCompactionWarmPrefixProvider === 'function') {
        setCompactionWarmPrefixProvider(() => {
          if (!state.compactWarmAllowed) return null;
          if (!state.lastRequestPayload || state.lastRequestPayload.messages.length === 0) return null;
          if (!AUTO_PREFIX_CACHE_RE.test(state.lastModelKey)) return null;
          if (!Array.isArray(state.lastRequestPayload.tools) || state.lastRequestPayload.tools.length === 0) return null;
          return { systemPrompt: "", tools: state.lastRequestPayload.tools, messages: state.lastRequestPayload.messages };
        });
      }
    } catch {
      // 补丁未应用时静默降级
    }
  })();
}
