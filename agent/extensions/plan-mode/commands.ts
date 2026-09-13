import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isPlanRevisionIntent, truncateSubject, mergePlanRevision } from "./utils.ts";
import { getState, replaceState, resetState } from "./store.ts";
import { selectTodoCounts } from "./selectors.ts";
import { formatPlanMessageLine } from "./view.ts";
import { runTodosCommand } from "./todo.ts";
import { runGit, isAssistantMessage, getTextContent, getUserText } from "./helpers.ts";
import { persistState } from "./index.ts";

const PLAN_USAGE = [
  "/plan                  切换规划模式（无参数，等同 Ctrl+Alt+P）",
  "/plan enter            进入规划模式（只读探索）",
  "/plan exit             退出规划模式（保留任务）",
  "/plan clear            清空所有计划任务",
  "/plan resume           恢复执行模式并继续未完成计划",
  "/plan view [--diff]    查看计划全文（--diff 显示与上一版差异）",
  "/plan view [--qa]      查看规划讨论问答历史",
  "/plan todos            按状态分组显示所有计划任务",
  "/plan help             显示本帮助",
].join("\n")

export function registerPlanCommand(
  pi: ExtensionAPI,
  state: {
    planModeEnabled: boolean;
    executionMode: boolean;
    planPresented: boolean;
    planDir: string | null;
    qaMessages: import("./helpers.ts").QAPair[];
    knownTodoHash: number;
    todoOverlay: import("./overlay.ts").TodoOverlay | undefined;
  },
  updateStatus: (ctx: ExtensionContext) => void,
  togglePlanMode: (ctx: ExtensionContext) => void,
  todoHash: () => number,
): void {
  pi.registerCommand("plan", {
    description: "计划模式：只读探索与任务跟踪（/plan help 查看用法）",
    getArgumentCompletions: (prefix) => {
      const first = (prefix.trim().split(/\s+/)[0] ?? "").toLowerCase()
      if (first === "view") {
        return [
          { value: "--diff", label: "view --diff", description: "显示与上一版差异" },
          { value: "--qa", label: "view --qa", description: "查看规划讨论问答历史" },
        ]
      }
      return [
        { value: "enter", label: "enter", description: "进入规划模式（只读探索）" },
        { value: "exit", label: "exit", description: "退出规划模式（保留任务）" },
        { value: "clear", label: "clear", description: "清空所有计划任务" },
        { value: "resume", label: "resume", description: "恢复执行模式并继续计划" },
        { value: "view", label: "view", description: "查看计划全文（--diff/--qa）" },
        { value: "todos", label: "todos", description: "按状态分组显示计划任务" },
        { value: "help", label: "help", description: "显示用法" },
      ]
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(" ")
      switch (sub) {
        case "enter":
          if (!state.planModeEnabled) togglePlanMode(ctx)
          break
        case "exit":
          if (state.planModeEnabled) togglePlanMode(ctx)
          break
        case "clear": {
          const curState = getState();
          const count = curState.tasks.filter((t) => t.status !== "deleted").length;
          if (count === 0) {
            ctx.ui.notify("当前没有计划任务。", "info");
            break
          }
          resetState();
          state.planPresented = false;
          state.knownTodoHash = 0;
          persistState();
          updateStatus(ctx);
          state.todoOverlay?.update();
          ctx.ui.notify(`已清空 ${count} 个计划任务。`);
          break
        }
        case "resume": {
          const curState = getState();
          const visible = curState.tasks.filter((t) => t.status !== "deleted");
          const remaining = visible.filter((t) => t.status !== "completed");
          if (remaining.length === 0) {
            ctx.ui.notify("没有可恢复的计划任务。请先 /plan enter 创建计划。", "info");
            break
          }
          state.planModeEnabled = false;
          state.executionMode = true;
          state.knownTodoHash = todoHash();
          // 与 plan_exit 路径一致：恢复全量工具（含扩展工具），
          // 硬编码静态清单会使扩展工具在本会话内全部不可用。
          const { restoreAllTools } = await import("./helpers.ts");
          restoreAllTools(pi);
          persistState();
          updateStatus(ctx);
          const first = remaining[0];
          pi.sendMessage(
            {
              customType: "plan-mode-execute",
              content: `继续执行计划。剩余 ${remaining.length} 步，从以下步骤开始: ${truncateSubject(first.subject)}`,
              display: true,
            },
            { triggerTurn: true },
          );
          break
        }
        case "view": {
          if (restArgs.includes("--diff")) {
            if (!state.planDir) {
              ctx.ui.notify("没有可对比的计划。请先创建计划。", "info");
              break
            }
            const { stdout: diff, code } = await runGit(
              pi,
              state.planDir,
              "git diff HEAD~1..HEAD -- plan.md 2>/dev/null || git show --stat HEAD",
            );
            if (code !== 0 && !diff.trim()) {
              ctx.ui.notify("没有之前的版本来对比。", "info");
              break
            }
            if (!diff.trim()) {
              ctx.ui.notify("与上一版无差异。", "info");
              break
            }
            pi.sendMessage(
              {
                customType: "plan-diff",
                content: `**计划差异对比:**\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``,
                display: true,
              },
              { triggerTurn: false },
            );
            break
          }
          if (restArgs.includes("--qa")) {
            if (state.qaMessages.length === 0) {
              ctx.ui.notify("暂无问答历史。", "info");
              break
            }
            const history = state.qaMessages
              .map(
                (qa, i) =>
                  `**${qa.role === "user" ? "你" : "Agent"}:**\n${qa.content}`,
              )
              .join("\n\n---\n\n");
            pi.sendMessage(
              {
                customType: "plan-qa-history",
                content: `**计划问答历史 (${state.qaMessages.length} 条消息):**\n\n${history}`,
                display: true,
              },
              { triggerTurn: false },
            );
            break
          }
          if (!state.planDir) {
            ctx.ui.notify("没有已保存的计划。请先创建计划。", "info");
            break
          }
          try {
            const { readFile } = await import("node:fs/promises");
            const { join } = await import("node:path");
            const content = await readFile(join(state.planDir, "plan.md"), "utf-8");
            pi.sendMessage(
              {
                customType: "plan-view",
                content: `**当前计划全文:**\n\n${content}`,
                display: true,
              },
              { triggerTurn: false },
            );
          } catch {
            ctx.ui.notify("无法读取计划文件。", "error");
          }
          break
        }
        case "todos":
          await runTodosCommand(pi, ctx)
          break
        case "help":
        case "-h":
        case "--help":
          ctx.ui.notify(PLAN_USAGE, "info")
          break
        case "":
          togglePlanMode(ctx)
          break
        default:
          ctx.ui.notify(`未知子命令: /plan ${sub}\n\n${PLAN_USAGE}`, "error")
      }
    },
  });
}
