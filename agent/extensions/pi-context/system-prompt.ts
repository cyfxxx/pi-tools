import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setContextWindow, setUsedTokens } from "../../lib/context-budget.ts";
import { resolveContext } from "./context-resolver.ts";
import {
  EFFICIENCY_ADVICE,
  LOW_PRESSURE_DELEGATION,
  FULL_DELEGATION_ADVICE,
} from "./advice-strings.ts";
import { enabledGroups, applyToolLayering, buildSleepingSummary } from "./tool-layering.ts";
import { recordToolEnable } from "./diagnostics.ts";

export function registerSystemPrompt(
  pi: ExtensionAPI,
  acState: {
    lastProviderContextTokens: number;
    fallbackContextWindow: number;
  },
): void {
  let layeringApplied = false;

  pi.on("before_agent_start", async (event, ctx) => {
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

    const resolved = resolveContext(ctx, acState.lastProviderContextTokens, acState.fallbackContextWindow);
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
