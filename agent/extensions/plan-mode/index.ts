import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
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
  truncateSubject,
} from "./utils.ts";
import { getTokenPressureTag, getUrgencyHint, getBudgetReport, resetBudget } from "../../lib/token-budget.ts";
import { loadNotes, clearCompactionFlag } from "../../lib/note-store.ts";

import { type Task, applyTaskMutation } from "./state.ts";
import { getState, commitState, replaceState, resetState } from "./store.ts";
import { selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { formatPlanMessageLine } from "./view.ts";
import { registerTodoTool, registerTodosCommand } from "./todo.ts";
import { TodoOverlay } from "./overlay.ts";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "glob"];
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
const MAX_PLANS = 20;

async function cleanupOldPlans(): Promise<void> {
  try {
    const entries = await readdir(PLANS_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(PLANS_DIR, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (dirs.length <= MAX_PLANS) return;

    for (const dir of dirs.slice(MAX_PLANS)) {
      await rm(dir.path, { recursive: true, force: true });
    }
  } catch {
    // directory may not exist yet
  }
}

type QAPair = { role: "user" | "assistant"; content: string };

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
): Promise<{ stdout: string; code: number }> {
  try {
    const result = (await pi.exec("bash", ["-c", command], { cwd })) as {
      stdout?: string;
      code?: number;
    };
    return { stdout: result?.stdout ?? "", code: result?.code ?? 0 };
  } catch {
    return { stdout: "", code: 1 };
  }
}

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
    const total = counts.total;

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
    planModeFullInjected = false;

    if (planModeEnabled) {
      // 进入规划模式：从干净状态开始
      resetState();
      planPresented = false;
      planDir = null;
      qaMessages = [];
      knownTodoHash = 0;
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify(`规划模式已启用。工具: ${PLAN_MODE_TOOLS.join(", ")}`);
    } else {
      // 退出规划模式：保留任务与进度（/planclear 可清空）
      planPresented = false;
      pi.setActiveTools(NORMAL_MODE_TOOLS);
      persistState();
      const state = getState();
      const count = state.tasks.filter((t) => t.status !== "deleted").length;
      ctx.ui.notify(
        count > 0
          ? `规划模式已禁用。任务已保留（${count} 项，/todos 查看，/planresume 继续执行）。`
          : "规划模式已禁用。完整权限已恢复。",
      );
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

    if (iteration === 1 || !planDir) {
      await runGit(pi, dir, "git init && git add plan.md && git commit -m 'initial'");
    } else {
      await runGit(pi, planDir, `git add plan.md && git commit -m 'iteration ${iteration}'`);
    }

    return dir;
  }

  let lastPersistedHash = 0;

  function persistState(): void {
    const state = getState();
    let h = 0;
    const tasksJson = JSON.stringify(state.tasks);
    for (let i = 0; i < tasksJson.length; i++) {
      h = ((h << 5) - h + tasksJson.charCodeAt(i)) | 0;
    }
    h = ((h << 5) - h + (planModeEnabled ? 1 : 0)) | 0;
    h = ((h << 5) - h + (executionMode ? 1 : 0)) | 0;
    h = ((h << 5) - h + (planPresented ? 1 : 0)) | 0;
    const qaJson = JSON.stringify(qaMessages);
    for (let i = 0; i < qaJson.length; i++) {
      h = ((h << 5) - h + qaJson.charCodeAt(i)) | 0;
    }
    if (planDir) {
      for (let i = 0; i < planDir.length; i++) {
        h = ((h << 5) - h + planDir.charCodeAt(i)) | 0;
      }
    }
    if (h === lastPersistedHash) return;

    lastPersistedHash = h;
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

  pi.registerCommand("plan", {
    description: "切换规划模式（只读探索）",
    handler: async (_args, ctx) => togglePlanMode(ctx),
  });

  pi.registerCommand("planclear", {
    description: "清空所有计划任务",
    handler: async (_args, ctx) => {
      const state = getState();
      const count = state.tasks.filter((t) => t.status !== "deleted").length;
      if (count === 0) {
        ctx.ui.notify("当前没有计划任务。", "info");
        return;
      }
      resetState();
      planPresented = false;
      knownTodoHash = 0;
      persistState();
      updateStatus(ctx);
      todoOverlay?.update();
      ctx.ui.notify(`已清空 ${count} 个计划任务。`);
    },
  });

  pi.registerCommand("planresume", {
    description: "恢复执行模式（继续未完成的计划）",
    handler: async (_args, ctx) => {
      const state = getState();
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      const remaining = visible.filter((t) => t.status !== "completed");
      if (remaining.length === 0) {
        ctx.ui.notify("没有可恢复的计划任务。请先 /plan 创建计划。", "info");
        return;
      }
      planModeEnabled = false;
      executionMode = true;
      knownTodoHash = todoHash();
      pi.setActiveTools(NORMAL_MODE_TOOLS);
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
    },
  });

  pi.registerCommand("planview", {
    description: "显示当前版本计划全文。--diff 显示与上一版差异，--qa 显示规划讨论问答历史。",
    handler: async (args, ctx) => {
      if (args.trim().includes("--diff")) {
        if (!planDir) {
          ctx.ui.notify("没有可对比的计划。请先创建计划。", "info");
          return;
        }
        const { stdout: diff, code } = await runGit(
          pi,
          planDir,
          "git diff HEAD~1..HEAD -- plan.md 2>/dev/null || git show --stat HEAD",
        );
        if (code !== 0 && !diff.trim()) {
          ctx.ui.notify("没有之前的版本来对比。", "info");
          return;
        }
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
        return;
      }
      if (args.trim().includes("--qa")) {
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
        return;
      }
      if (!planDir) {
        ctx.ui.notify("没有已保存的计划。请先创建计划。", "info");
        return;
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(join(planDir, "plan.md"), "utf-8");
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

  // 注入型消息：每种类型只保留最新一条，避免历史消息永久累积浪费 token
  const INJECTED_CUSTOM_TYPES = new Set([
    "plan-mode-context",
    "plan-execution-context",
    "plan-pressure-tag",
    "plan-mode-recovery",
    "plan-urgency-hint",
    "plan-summary-request",
    "plan-skill-list",
    "plan-complete",
    "plan-revise",
    "plan-todo-list",
    "plan-progress",
  ]);

  pi.on("context", async (event) => {
    const seen = new Set<string>();
    const filtered: typeof event.messages = [];
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      const msg = m as AgentMessage & { customType?: string };
      const customType = msg.customType;
      if (customType && INJECTED_CUSTOM_TYPES.has(customType)) {
        if (seen.has(customType)) continue;
        seen.add(customType);
      }
      filtered.unshift(m);
    }
    return { messages: filtered };
  });

  // 动态扫描可用技能（~/.pi/agent/skills/*/SKILL.md）
  function discoverSkills(): { name: string; desc: string }[] {
    const base = join(homedir(), ".pi", "agent", "skills");
    try {
      const entries = readdirSync(base, { withFileTypes: true });
      const skills: { name: string; desc: string }[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        try {
          const content = readFileSync(join(base, name, "SKILL.md"), "utf-8");
          const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
          const desc =
            fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
          skills.push({ name, desc });
        } catch {
          skills.push({ name, desc: "" });
        }
      }
      return skills;
    } catch {
      return [];
    }
  }

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
- 只能使用: read, bash, grep, glob
- 不能使用: edit, write（文件修改已禁用）
- Bash 命令限制为只读白名单

创建计划前:
- 如果需求不明确，先提出澄清问题。
- 检查代码库以了解当前结构。
- 进行影响分析（在计划前用以下结构输出）:
  影响文件: <将变化的文件清单>
  风险: <可能破坏的内容、边界情况>
  未知点: <需要用户确认的假设>

计划的步骤要求:
- 每步一个可独立执行的改动，粒度适中（可单独验证）。
- 编号从 1 开始，顺序按依赖排列。

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
      const currentHash = todoHash();
      if (visible.length > 0 && currentHash !== knownTodoHash) {
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
    }

    // Check for compaction recovery (P1)
    const notes = loadNotes();
    if (notes["_ctx.just_compacted"] === "true") {
      clearCompactionFlag();
      return {
        message: {
          customType: "plan-mode-recovery",
          content: "上下文已压缩。继续之前的工作。\n请继续执行。",
          display: false,
        },
      };
    }

    // Inject urgency hint if pressure is high (P3)
    const urgencyHint = getUrgencyHint();
    if (urgencyHint) {
      return {
        message: {
          customType: "plan-urgency-hint",
          content: urgencyHint,
          display: false,
        },
      };
    }

    // Inject summary guidance if pressure is critical (P2)
    if (getBudgetReport().pressure === "critical") {
      return {
        message: {
          customType: "plan-summary-request",
          content: "=== 上下文压缩请求 ===\n上下文窗口即将填满。请立即：\n1. 用 ctx_note 记录关键决策和已完成工作\n2. 格式：ctx_note key='session.summary' value='## 目标\\n## 已完成的步骤\\n## 关键发现\\n## 相关文件'\n3. 然后通知用户执行 /compact 压缩上下文",
          display: false,
        },
      };
    }

    // 注入可用技能清单（仅一次，动态扫描）
    if (!skillsInjected) {
      skillsInjected = true;
      const skills = discoverSkills();
      if (skills.length > 0) {
        const skillList = skills
          .map((s) => `  /skill:${s.name} — ${s.desc}`)
          .join("\n");
        return {
          message: {
            customType: "plan-skill-list",
            content: `[可用技能]\n${skillList}\n\n当用户需求匹配时，提示用户使用对应技能或回复 /skill:name。`,
            display: false,
          },
        };
      }
    }

    // 执行模式：todo 未变化时仅注入压力标签
    if (executionMode) {
      const pressureTag = getTokenPressureTag();
      if (pressureTag) {
        return {
          message: {
            customType: "plan-pressure-tag",
            content: pressureTag,
            display: false,
          },
        };
      }
    }
  });

  // Track progress after each turn
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode) return;
    if (!isAssistantMessage(event.message)) return;

    // 实时进度：任务状态变化时发一条精简进度消息（仅保留最新，不刷屏）
    const state = getState();
    const currentHash = todoHash();
    if (currentHash !== knownTodoHash) {
      knownTodoHash = currentHash;
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0) {
        const counts = selectTodoCounts(state);
        const lines = visible
          .filter((t) => t.status === "in_progress" || t.status === "completed")
          .map((t) => formatPlanMessageLine(t));
        const remaining = counts.total - counts.completed;
        const tail = remaining > 0 ? `\n剩余 ${remaining} 步` : "";
        pi.sendMessage(
          {
            customType: "plan-progress",
            content: `**计划进度 (${counts.completed}/${counts.total}):**\n${lines.join("\n") || "(无进行中步骤)"}${tail}`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }

    updateStatus(ctx);
    todoOverlay?.update();
    persistState();
  });

  // Handle plan completion and plan mode UI
  pi.on("agent_end", async (event, ctx) => {
    // 执行模式：检测计划修订（LLM 输出新的 Plan: 块且用户明确要求修改）
    if (executionMode) {
      const lastAssistant = [...event.messages]
        .reverse()
        .find(isAssistantMessage);
      const lastText = lastAssistant ? getTextContent(lastAssistant) : "";
      const extracted = lastText ? extractTodoItems(lastText) : [];
      if (extracted.length > 0 && isPlanRevisionIntent(lastText)) {
        let state = getState();
        const completed = state.tasks.filter(
          (t) => t.status === "completed" || t.status === "deleted",
        );
        const maxId =
          completed.length > 0 ? Math.max(...completed.map((t) => t.id)) : 0;
        const newTasks = [...completed];
        for (const item of extracted) {
          newTasks.push({
            id: maxId + item.id,
            subject: item.subject,
            status: "pending",
          });
        }
        replaceState({ tasks: newTasks, nextId: maxId + extracted.length + 1 });
        persistState();
        updateStatus(ctx);
        todoOverlay?.update();
        pi.sendMessage(
          {
            customType: "plan-revise",
            content: `**计划已修订** — 未完成任务已替换为 ${extracted.length} 个新步骤：\n\n${extracted
              .map((t) => `${t.id}. ${t.subject}`)
              .join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
      }

      const state = getState();
      const visible = state.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0 && visible.every((t) => t.status === "completed")) {
        const completedList = visible.map((t) => `~~${truncateSubject(t.subject)}~~`).join("\n");
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
            const { stdout } = await runGit(pi, planDir, "git rev-list --count HEAD");
            const count = Number(stdout.trim());
            iteration = Number.isFinite(count) && count > 0 ? count + 1 : 2;
          }
		savePlanIteration(lastText, iteration).then((dir) => {
			planDir = dir;
			persistState();
		}).catch((err) => {
			console.error("plan-mode: Failed to save plan iteration:", err);
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

    // Only show choice when todos actually changed or plan is brand new
    const state = getState();
    const visible = state.tasks.filter((t) => t.status !== "deleted");
    const needsChoice = visible.length > 0 && todoHash() !== knownTodoHash;
    if (!needsChoice) return;

    // Show plan steps (仅在计划有变化时展示，避免重复刷屏)
    if (visible.length > 0) {
      const counts = selectTodoCounts(state);
      const todoListText = visible.map((t) => formatPlanMessageLine(t)).join("\n");
      pi.sendMessage(
        {
          customType: "plan-todo-list",
          content: `**计划步骤 (${counts.completed}/${counts.total}):**\n\n${todoListText}`,
          display: true,
        },
        { triggerTurn: false },
      );
    }

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
          ? `执行计划。从以下步骤开始: ${truncateSubject(firstTask.subject)}`
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
    cleanupOldPlans();
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
