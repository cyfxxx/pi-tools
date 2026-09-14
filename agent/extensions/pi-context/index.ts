/**
 * index.ts — pi-context 编排层
 *
 * 本文件仅保留状态初始化 + 模块组装逻辑。
 * 各功能域已拆分至独立模块：
 *   advice-strings.ts     — 静态指令文案
 *   message-utils.ts      — extractUserRequest 纯函数
 *   admin-state.ts        — 重启来源判定
 *   prune-dump.ts         — 擦除溯源落盘
 *   context-resolver.ts   — 上下文解析
 *   task-gate.ts          — 空闲/任务门控
 *   warm-prefix-replay.ts — 暖前缀重放
 *   tool-lifecycle.ts     — 工具调用记录+截断+熔断
 *   message-filtering.ts  — context 阶段过滤
 *   auto-compact-controller.ts — 自动压缩编排
 *   system-prompt.ts      — 系统提示注入
 *   tool-registrations.ts — enable_tool/thinking_level/tools 命令
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWarmPrefixState, registerWarmPrefixReplay } from "./warm-prefix-replay.ts";
export { EFFICIENCY_ADVICE, LOW_PRESSURE_DELEGATION, FULL_DELEGATION_ADVICE } from "./advice-strings.ts";
import { createToolLifecycleState, registerToolLifecycle } from "./tool-lifecycle.ts";
import { createMessageFilterState, registerMessageFilter } from "./message-filtering.ts";
import { createAutoCompactState, registerAutoCompactController } from "./auto-compact-controller.ts";
import { registerSystemPrompt } from "./system-prompt.ts";
import { registerToolRegistrations } from "./tool-registrations.ts";

const MAX_TOOL_BYTES = 5000;
const MAX_OTHER_TOOL_BYTES = 20 * 1024;

export default function (pi: ExtensionAPI) {
  // ── 共享状态 ──
  const warmState = createWarmPrefixState();
  const toolState = createToolLifecycleState();
  const msgState = createMessageFilterState();
  const acState = createAutoCompactState();
  const thinkStateRef: { current: any } = { current: null };

  // ── 注册各模块 ──
  registerWarmPrefixReplay(pi, warmState);
  registerToolLifecycle(pi, toolState, MAX_TOOL_BYTES, MAX_OTHER_TOOL_BYTES);
  registerMessageFilter(pi, msgState);
  registerAutoCompactController(
    pi,
    acState,
    warmState,
    toolState,
    msgState,
    thinkStateRef,
    typeof pi.setThinkingLevel === "function" ? (l: string) => pi.setThinkingLevel(l as any) : undefined,
    typeof pi.getThinkingLevel === "function" ? () => pi.getThinkingLevel() : undefined,
  );
  registerSystemPrompt(pi, acState);
  registerToolRegistrations(pi, thinkStateRef);

  // before_agent_start 更新 modelKey（需在 warm-prefix-replay 之后）
  pi.on("before_agent_start", async (_event, ctx) => {
    warmState.lastModelKey = `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
  });
}
