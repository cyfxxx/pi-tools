import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  extractTodoItems,
  isPlanRevisionIntent,
  isSafeCommand,
} from "./utils.ts";
import { getTokenPressureTag, resetBudget } from "../../lib/token-budget.ts";

import { type Task, applyTaskMutation } from "./state.ts";
import { getState, commitState, replaceState, resetState } from "./store.ts";
import { selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { registerTodoTool, registerTodosCommand } from "./todo.ts";
import { TodoOverlay } from "./overlay.ts";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "glob", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const PLANS_DIR = join(homedir(), ".pi", "plans");

type QAPair = { role: "user" | "assistant"; content: string };

export default function planModeExtension(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let planPresented = false;
  let planDir: string | null = null;
  let qaMessages: QAPair[] = [];
  let planModeFullInjected = false;
  let knownTodoHash = 0;
  let skillsInjected = false;

  let todoOverlay: TodoOverlay | undefined;

  function todoHash(): number {
    const state = getState();
    let h = 0;
    for (const t of state.tasks) {
      h = ((h << 5) - h + t.id) | 0;
      for (let i = 0; i < t.subject.length; i++) {
        h = ((h << 5) - h + t.subject.charCodeAt(i)) | 0;
      }
      h = ((h << 5) - h + (t.status === "completed" ? 1 : 0)) | 0;
    }
    return h;
  }

  pi.registerFlag("plan", {
    description: "以规划模式启动（只读探索）",
    type: "boolean",
    default: false,
  });

  function updateStatus(ctx: ExtensionContext): void {
    const state = getState();
    const counts = selectTodoCounts(state);
    const total = counts.pending + counts.inProgress + counts.completed;

    if (executionMode && total > 0) {
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${counts.completed}/${total}`),
      );
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
    }

    if (executionMode && total > 0) {
      todoOverlay?.update();
    } else {
      ctx.ui.setWidget("plan-todos-simple", undefined);
    }
  }

  function togglePlanMode(ctx: ExtensionContext): void {
    planModeEnabled = !planModeEnabled;
    executionMode = false;
    resetState();
    planPresented = false;
    planDir = null;
    qaMessages = [];
    knownTodoHash = 0;

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify(`规划模式已启用。工具: ${PLAN_MODE_TOOLS.join(", ")}`);
    } else {
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      ctx.ui.notify("规划模式已禁用。完整权限已恢复。");
    }
    updateStatus(ctx);
  }

  async function savePlanIteration(
    planText: string,
    iteration: number,
  ): Promise<string> {
    const timestamp = Date.now();
    const dir = planDir ?? join(PLANS_DIR, `plan-${timestamp}`);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan.md"), planText);

    try {
      if (iteration === 1 || !planDir) {
        execSync("git init && git add plan.md && git commit -m 'initial'", {
          cwd: dir,
          encoding: "utf-8",
        });
      } else {
        execSync(`git add plan.md && git commit -m 'iteration ${iteration}'`, {
          cwd: planDir,
          encoding: "utf-8",
        });
      }
    } catch {
      // git not available — silently skip versioning
    }

    return dir;
  }

  function persistState(): void {
    const state = getState();
    pi.appendEntry("plan-mode", {
      enabled: planModeEnabled,
      tasks: state.tasks,
      nextId: state.nextId,
      executing: executionMode,
      planPresented,
      planDir,
      qaMessages,
    });
  }

  registerTodoTool(pi);
  registerTodosCommand(pi);

  // ─── task 子代理工具 ───────────────────────────────────────────
  pi.registerTool({
    name: "task",
    label: "子任务",
    description: "创建独立子任务描述文件，供用户在新会话中执行。用于需要并行探索或独立执行的独立子任务。",
    promptSnippet: "创建子任务",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "子任务详细描述" },
        context: { type: "string", description: "子任务需要的上下文信息" },
      },
      required: ["description"],
    },
    async execute(_id, params) {
      const ts = Date.now();
      const taskFile = join(homedir(), ".pi", "tasks", `task-${ts}.md`);
      await mkdir(join(homedir(), ".pi", "tasks"), { recursive: true });
      const content = `# 子任务 ${ts}

## 描述
${params.description}

## 上下文
${params.context ?? "无"}

---
创建于: ${new Date(ts).toISOString()}
`;
      await writeFile(taskFile, content);
      return {
        content: [{
          type: "text",
          text: `子任务已创建: ${taskFile}\n请用户在新会话中打开此文件继续执行。\n当前会话继续主任务。`,
        }],
      };
    },
  });

  pi.registerCommand("plan", {
    description: "切换规划模式（只读探索）",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("plandiff", {
    description: "显示当前与上一版规划的差异",
    handler: async (_args, ctx) => {
      if (!planDir) {
        ctx.ui.notify("没有可对比的计划。请先创建计划。", "info");
        return;
      }
      try {
        const diff = execSync(
          "git diff HEAD~1..HEAD -- plan.md 2>/dev/null || git show --stat HEAD",
          { cwd: planDir, encoding: "utf-8" },
        );
        if (!diff.trim()) {
          ctx.ui.notify("与上一版无差异。", "info");
          return;
        }
        pi.sendMessage(
          {
            customType: "plan-diff",
            content: `**计划差异对比:**\n\n\`\`\`diff\n${diff.trim()}\n\`\`\``,
            display: true,
          },
          { triggerTurn: false },
        );
      } catch {
        ctx.ui.notify("没有之前的版本来对比。", "info");
      }
    },
  });

  pi.registerCommand("planqa", {
    description: "显示当前规划讨论的问答历史",
    handler: async (_args, ctx) => {
      if (qaMessages.length === 0) {
        ctx.ui.notify("暂无问答历史。", "info");
        return;
      }
      const history = qaMessages
        .map(
          (qa, i) =>
            `**${qa.role === "user" ? "你" : "Agent"}:**\n${qa.content}`,
        )
        .join("\n\n---\n\n");
      pi.sendMessage(
        {
          customType: "plan-qa-history",
          content: `**计划问答历史 (${qaMessages.length} 条消息):**\n\n${history}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "切换计划模式",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // Block destructive bash commands in plan mode
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `规划模式: 命令被阻止（不在白名单中）。使用 /plan 退出规划模式。\n命令: ${command}`,
      };
    }
  });

  // Filter out stale plan mode context when not in plan mode
  pi.on("context", async (event) => {
    if (planModeEnabled) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-mode-context") return false;
        if (msg.role !== "user") return true;

        const content = msg.content;
        if (typeof content === "string") {
          return !content.includes("[PLAN MODE ACTIVE]");
        }
        if (Array.isArray(content)) {
          return !content.some(
            (c) =>
              c.type === "text" &&
              (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
          );
        }
        return true;
      }),
    };
  });

  // Inject plan/execution context before agent starts
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      const pressureTag = getTokenPressureTag() || "";
      const preamble = pressureTag ? `${pressureTag}\n` : "";
      const content = planModeFullInjected
        ? `${preamble}[PLAN MODE] 保持相同规则。使用 /plan 退出。`
        : `${preamble}[PLAN MODE ACTIVE]
你处于规划模式 - 一种用于安全代码分析的只读探索模式。

限制:
- 只能使用: read, bash, grep, glob, questionnaire
- 不能使用: edit, write（文件修改已禁用）
- Bash 命令限制为只读白名单

创建计划前:
- 如果需求不明确，先提出澄清问题。
- 检查代码库以了解当前结构。
- 进行影响分析：识别哪些文件会变化、可能破坏什么、边界情况。

在 "Plan:" 头部下创建详细的编号计划:

Plan:
1. 第一步描述
2. 第二步描述
...

不要尝试修改文件——只描述你要做什么。

计划展示后: 如果用户提出正常的后续问题
（为什么、是什么、解释一下），用文字回答——不要输出另一个 Plan: 块。
只有在用户明确要求修改、变更或更新时，才输出修订后的 "Plan:" 部分。`;
      planModeFullInjected = true;
      return {
        message: {
          customType: "plan-mode-context",
          content,
          display: false,
        },
      };
    }

    if (executionMode) {
      const state = getState();
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      if (visible.length === 0) return;

      const currentHash = todoHash();
      if (currentHash === knownTodoHash) {
        const pressureTag = getTokenPressureTag();
        if (pressureTag) {
          return { message: { customType: "plan-pressure-tag", content: pressureTag, display: false } };
        }
        return;
      }
      knownTodoHash = currentHash;
      const pressureTag = getTokenPressureTag() || "";
      const preamble = pressureTag ? `${pressureTag}\n` : "";
      const remaining = visible.filter((t) => t.status !== "completed");
      const counts = selectTodoCounts(state);
      const todoList = remaining.map((t) => `${t.id}. ${t.subject}`).join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `${preamble}[执行中: ${counts.completed}/${counts.total} 已完成]

剩余步骤:
${todoList}

完成步骤时使用: todo update id=N status=completed
开始步骤时使用: todo update id=N status=in_progress activeForm='正在...'`,
          display: false,
        },
      };
    }
    // 注入可用技能清单（仅一次）
    if (!skillsInjected) {
      skillsInjected = true;
      const skills = [
        { name: "pi-backup", desc: "备份和恢复 agent 配置、扩展、技能" },
        { name: "pi-translate-zh", desc: "Pi TUI 完整中文化补丁" },
      ];
      const skillList = skills.map(s => `  /skill:${s.name} — ${s.desc}`).join("\n");
      return {
        message: {
          customType: "plan-skill-list",
          content: `[可用技能]\n${skillList}\n\n当用户需求匹配时，提示用户使用对应技能或回复 /skill:name。`,
          display: false,
        },
      };
    }
  });

  // Track progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode) return;
    if (!isAssistantMessage(event.message)) return;

    updateStatus(ctx);
    todoOverlay?.update();
    persistState();
  });

  // Handle plan completion and plan mode UI
  pi.on("agent_end", async (event, ctx) => {
    // Check if execution is complete
    if (executionMode) {
      const state = getState();
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0 && visible.every((t) => t.status === "completed")) {
        const completedList = visible.map((t) => `~~${t.subject}~~`).join("\n");
        pi.sendMessage(
          {
            customType: "plan-complete",
            content: `**计划完成!** ✓\n\n${completedList}`,
            display: true,
          },
          { triggerTurn: false },
        );
        executionMode = false;
        pi.setActiveTools(NORMAL_MODE_TOOLS);
        updateStatus(ctx);
        todoOverlay?.update();
        persistState();
      }
      return;
    }

    if (!planModeEnabled || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const lastAssistant = [...event.messages]
      .reverse()
      .find(isAssistantMessage);
    if (lastAssistant) {
      const lastText = getTextContent(lastAssistant);
      const extracted = extractTodoItems(lastText);
      if (extracted.length > 0) {
        const isNewPlan = !planPresented || isPlanRevisionIntent(lastText);
        if (isNewPlan) {
          // Create tasks via reducer
          let state = getState();
          for (const item of extracted) {
            const result = applyTaskMutation(state, "create", {
              subject: item.subject,
            } as Record<string, unknown>);
            if (result.op.kind !== "error") {
              state = result.state;
            }
          }
          commitState(state);

          // Save plan to git repo
          let iteration = 1;
          if (planDir) {
            try {
              iteration =
                Number(
                  execSync("git rev-list --count HEAD", {
                    cwd: planDir,
                    encoding: "utf-8",
                  }).trim(),
                ) + 1;
            } catch {
              iteration = 2;
            }
          }
          savePlanIteration(lastText, iteration).then((dir) => {
            planDir = dir;
            persistState();
          });
        }
        planPresented = true;
      }

      // Capture Q&A pair when plan has been presented
      if (planPresented) {
        const lastUser = [...event.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser) {
          const userContent =
            typeof lastUser.content === "string" ? lastUser.content : "";
          if (userContent.trim()) {
            qaMessages.push({ role: "user", content: userContent });
          }
        }
        qaMessages.push({
          role: "assistant",
          content: lastText.slice(0, 500),
        });

        if (qaMessages.length > 6) {
          qaMessages = qaMessages.slice(-6);
        }
      }
    }

    // Show plan steps
    const state = getState();
    const visible = state.tasks.filter((t) => t.status !== "deleted");
    if (visible.length > 0) {
      const todoListText = visible
        .map((t) => `${t.id}. ☐ ${t.subject}`)
        .join("\n");
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**计划步骤 (${visible.length}):**\n\n${todoListText}`,
          display: true,
        },
        { triggerTurn: false },
      );
    }

    // Only show choice when todos actually changed or plan is brand new
    const needsChoice = visible.length > 0 && todoHash() !== knownTodoHash;
    if (!needsChoice) return;

    const choice = await ctx.ui.select("计划模式 - 下一步?", [
      visible.length > 0
        ? "执行计划（追踪进度）"
        : "执行计划",
      "继续计划模式",
      "优化计划",
    ]);

    if (choice?.startsWith("执行计划")) {
      planModeEnabled = false;
      executionMode = visible.length > 0;
      knownTodoHash = todoHash();
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      updateStatus(ctx);
      todoOverlay?.update();

      const firstTask = visible[0];
      const execMessage =
        firstTask
          ? `执行计划。从以下步骤开始: ${firstTask.subject}`
          : "执行你刚创建的计划。";
      pi.sendMessage(
        {
          customType: "plan-mode-execute",
          content: execMessage,
          display: true,
        },
        { triggerTurn: true },
      );
    } else if (choice === "优化计划") {
      const refinement = await ctx.ui.editor("优化计划:", "");
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    resetBudget();
    resetState();

    if (pi.getFlag("plan") === true) {
      planModeEnabled = true;
    }

    const entries = ctx.sessionManager.getEntries();

    // Restore persisted state
    const planModeEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-mode",
      )
      .pop() as
      | {
          data?: {
            enabled: boolean;
            tasks?: Task[];
            nextId?: number;
            executing?: boolean;
            planPresented?: boolean;
            planDir?: string | null;
            qaMessages?: QAPair[];
          };
        }
      | undefined;

    if (planModeEntry?.data) {
      planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
      executionMode = planModeEntry.data.executing ?? executionMode;
      planPresented = planModeEntry.data.planPresented ?? planPresented;
      planDir = planModeEntry.data.planDir ?? planDir;
      qaMessages = planModeEntry.data.qaMessages ?? qaMessages;

      if (planModeEntry.data.tasks) {
        replaceState({
          tasks: planModeEntry.data.tasks,
          nextId: planModeEntry.data.nextId ?? 1,
        });
      }
    }

    // Restore overlay UI
    if (ctx.hasUI) {
      todoOverlay ??= new TodoOverlay();
      todoOverlay.setUICtx(ctx.ui);
      todoOverlay.resetCompletedDisplayState();
      todoOverlay.update();
    }

    // On resume: re-scan messages to rebuild completion state
    const isResume = planModeEntry !== undefined;
    if (isResume && executionMode) {
      const state = getState();
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0) {
        updateStatus(ctx);
        todoOverlay?.update();
      }
    }

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    }
    updateStatus(ctx);
  });

  // Overlay lifecycle handlers
  pi.on("session_compact", async (_event, ctx) => {
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    todoOverlay?.resetCompletedDisplayState();
    todoOverlay?.update();
  });

  pi.on("session_shutdown", async () => {
    todoOverlay?.dispose();
    todoOverlay = undefined;
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    todoOverlay?.update();
  });

  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}
