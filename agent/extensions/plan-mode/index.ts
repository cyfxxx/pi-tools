import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { type Task, type TaskState } from "./state.ts";
import { getState, replaceState, resetState } from "./store.ts";
import { selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { formatPlanMessageLine, parsePlanFile, renderPlanFile } from "./view.ts";
import { registerTodoTool, runTodosCommand } from "./todo.ts";
import { TodoOverlay } from "./overlay.ts";
import {
  restoreAllTools,
  isAssistantMessage,
  getTextContent,
  getUserText,
  cleanupOldPlans,
  resolvePlanModeEnabled,
  capQaMessages,
  runGit,
  PLANS_DIR,
  type QAPair,
} from "./helpers.ts";
import { PLAN_MODE_TOOLS, registerAskUserTool, registerPlanEnterTool, registerPlanExitTool } from "./tools.ts";
import { registerPlanCommand } from "./commands.ts";
import { registerEventHandlers } from "./events.ts";

// 导出供 events.ts 使用
export async function savePlanIteration(
  content: string,
  iteration: number,
): Promise<string> {
  const timestamp = Date.now();
  const dir = join(PLANS_DIR, `plan-${timestamp}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.md"), content);
  return dir;
}

export async function persistState(): Promise<void> {
  // 持久化状态到 session
  // 这里简化处理，实际实现需要与 pi session 系统集成
}

export default function planModeExtension(pi: ExtensionAPI): void {
  // 内部状态
  let planModeEnabled = false;
  let executionMode = false;
  let planPresented = false;
  let planDir: string | null = null;
  let qaMessages: QAPair[] = [];
  let planModeFullInjected = false;
  let knownTodoHash = 0;
  let skillsInjected = false;
  let planSaveGen = 0;

  let todoOverlay: TodoOverlay | undefined;

  function todoHash(): number {
    const curState = getState();
    const statusVal: Record<string, number> = {
      pending: 1,
      in_progress: 2,
      blocked: 3,
      completed: 4,
      deleted: 5,
    };
    let h = 0;
    for (const t of curState.tasks) {
      h = ((h << 5) - h + t.id) | 0;
      for (let i = 0; i < t.subject.length; i++) {
        h = ((h << 5) - h + t.subject.charCodeAt(i)) | 0;
      }
      // 完整状态参与 hash：仅区分 completed 会导致 pending→in_progress/
      // blocked 变化不触发注入（首个任务开始时列表不刷新）
      h = ((h << 5) - h + (statusVal[t.status] ?? 0)) | 0;
      if (t.activeForm) {
        for (let i = 0; i < t.activeForm.length; i++) {
          h = ((h << 5) - h + t.activeForm.charCodeAt(i)) | 0;
        }
      }
      h = ((h << 5) - h + (t.failures?.length ?? 0)) | 0;
    }
    return h;
  }

  pi.registerFlag("plan", {
    description: "以规划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    const curState = getState();
    const counts = selectTodoCounts(curState);
    const total = counts.total;

    if (executionMode && total > 0) {
      // All completed: directly clear status bar (don't rely on message event's executionMode exit -
      // last task marked complete by todo tool happens after message event, event won't trigger)
      if (counts.completed >= total) {
        ctx.ui.setStatus("plan-mode", undefined);
      } else {
        ctx.ui.setStatus(
          "plan-mode",
          ctx.ui.theme.fg("accent", `📋 ${counts.completed}/${total}`),
        );
      }
    } else if (planModeEnabled) {
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 规划 ${counts.completed}/${total}`),
      );
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    if (planModeEnabled) {
      executionMode = false;
      planModeFullInjected = false;
      resetState();
      planPresented = false;
      planDir = null;
      qaMessages = [];
      knownTodoHash = 0;
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify("规划模式已启用。工具已限制为只读。");
    } else {
      restoreAllTools(pi);
      ctx.ui.notify("规划模式已禁用。完整权限已恢复。");
    }
    updateStatus(ctx);
  }

  // 注册工具
  registerTodoTool(pi);
  registerAskUserTool(pi);
  registerPlanEnterTool(pi, {
    get planModeEnabled() { return planModeEnabled; },
    set planModeEnabled(v: boolean) { planModeEnabled = v; },
    get executionMode() { return executionMode; },
    set executionMode(v: boolean) { executionMode = v; },
    get planModeFullInjected() { return planModeFullInjected; },
    set planModeFullInjected(v: boolean) { planModeFullInjected = v; },
    get planPresented() { return planPresented; },
    set planPresented(v: boolean) { planPresented = v; },
    get planDir() { return planDir; },
    set planDir(v: string | null) { planDir = v; },
    get qaMessages() { return qaMessages; },
    set qaMessages(v: QAPair[]) { qaMessages = v; },
    get knownTodoHash() { return knownTodoHash; },
    set knownTodoHash(v: number) { knownTodoHash = v; },
  }, updateStatus);
  registerPlanExitTool(pi, {
    get planModeEnabled() { return planModeEnabled; },
    set planModeEnabled(v: boolean) { planModeEnabled = v; },
    get executionMode() { return executionMode; },
    set executionMode(v: boolean) { executionMode = v; },
    get planModeFullInjected() { return planModeFullInjected; },
    set planModeFullInjected(v: boolean) { planModeFullInjected = v; },
    get planPresented() { return planPresented; },
    set planPresented(v: boolean) { planPresented = v; },
  }, updateStatus);

  // 注册命令
  registerPlanCommand(pi, {
    get planModeEnabled() { return planModeEnabled; },
    set planModeEnabled(v: boolean) { planModeEnabled = v; },
    get executionMode() { return executionMode; },
    set executionMode(v: boolean) { executionMode = v; },
    get planPresented() { return planPresented; },
    set planPresented(v: boolean) { planPresented = v; },
    get planDir() { return planDir; },
    set planDir(v: string | null) { planDir = v; },
    get qaMessages() { return qaMessages; },
    set qaMessages(v: QAPair[]) { qaMessages = v; },
    get knownTodoHash() { return knownTodoHash; },
    set knownTodoHash(v: number) { knownTodoHash = v; },
    get todoOverlay() { return todoOverlay; },
    set todoOverlay(v: TodoOverlay | undefined) { todoOverlay = v; },
  }, updateStatus, togglePlanMode, todoHash);

  // 注册快捷键
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // 注册事件处理器
  registerEventHandlers(pi, {
    get planModeEnabled() { return planModeEnabled; },
    set planModeEnabled(v: boolean) { planModeEnabled = v; },
    get executionMode() { return executionMode; },
    set executionMode(v: boolean) { executionMode = v; },
    get planPresented() { return planPresented; },
    set planPresented(v: boolean) { planPresented = v; },
    get planDir() { return planDir; },
    set planDir(v: string | null) { planDir = v; },
    get qaMessages() { return qaMessages; },
    set qaMessages(v: QAPair[]) { qaMessages = v; },
    get planModeFullInjected() { return planModeFullInjected; },
    set planModeFullInjected(v: boolean) { planModeFullInjected = v; },
    get knownTodoHash() { return knownTodoHash; },
    set knownTodoHash(v: number) { knownTodoHash = v; },
    get skillsInjected() { return skillsInjected; },
    set skillsInjected(v: boolean) { skillsInjected = v; },
    get todoOverlay() { return todoOverlay; },
    set todoOverlay(v: TodoOverlay | undefined) { todoOverlay = v; },
    get planSaveGen() { return planSaveGen; },
    set planSaveGen(v: number) { planSaveGen = v; },
  }, updateStatus, todoHash);

  // 工具快照重建（普通会话）：扩展加载即用全量工具集刷新会话 tools 快照，
  // 保证新注册的工具（plan_enter/plan_exit 等）对模型可见——
  // setActiveToolsByName 只重建系统提示，不自动同步注册表新增。
  // plan 模式会话会在 session_start 覆盖为 PLAN_MODE_TOOLS。
  try {
    const active = pi.getActiveTools();
    if (active.length === 0 || !active.includes("plan_enter")) {
      const all = pi.getAllTools().map((t) => t.name);
      pi.setActiveTools(all);
    }
  } catch {
    // runtime 未激活时跳过；session_start 兜底重建
  }
}
