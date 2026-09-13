import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { extractTodoItems, isPlanRevisionIntent, mergePlanRevision, truncateSubject, isSafeCommand, assertPlanSubagentAllowed } from "./utils.ts";
import { getTokenPressureTag, getUrgencyHint, getBudgetReport, resetBudget } from "../../lib/token-budget.ts";
import { loadNotes, clearCompactionFlag } from "../../lib/note-store.ts";
import { Key } from "@earendil-works/pi-tui";

import { type Task, type TaskState, cleanupReminderCheck } from "./state.ts";
import { getState, replaceState } from "./store.ts";
import { selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { formatPlanMessageLine, renderPlanFile } from "./view.ts";
import { TodoOverlay } from "./overlay.ts";
import {
  restoreAllTools,
  isAssistantMessage,
  getTextContent,
  getUserText,
  cleanupOldPlans,
  resolvePlanModeEnabled,
  discoverSkills,
  runGit,
  PLANS_DIR,
  type QAPair,
} from "./helpers.ts";
import { PLAN_MODE_TOOLS } from "./tools.ts";
import { persistState, savePlanIteration } from "./index.ts";

export function registerEventHandlers(
  pi: ExtensionAPI,
  state: {
    planModeEnabled: boolean;
    executionMode: boolean;
    planPresented: boolean;
    planDir: string | null;
    qaMessages: QAPair[];
    planModeFullInjected: boolean;
    knownTodoHash: number;
    skillsInjected: boolean;
    todoOverlay: TodoOverlay | undefined;
    planSaveGen: number;
  },
  updateStatus: (ctx: ExtensionContext) => void,
  todoHash: () => number,
): void {
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

  // Block destructive bash commands and unsafe subagent use in plan mode
  pi.on("tool_call", async (event) => {
    if (!state.planModeEnabled) return;

    // 只读保护：edit/write 硬拦截（不依赖 setActiveTools 移除工具——
    // 恢复会话工具快照可能残留，此拦截是防御性兜底，参考 opencode
    // plan agent 的 edit: deny 权限设计）
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `规划模式: ${event.toolName} 被阻止（只读探索，文件修改已禁用）。使用 /plan 退出规划模式。`,
      };
    }

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `规划模式: 命令被阻止（不在白名单中）。使用 /plan 退出规划模式。\n命令: ${command}`,
        };
      }
    }

    if (event.toolName === "subagent") {
      const reason = assertPlanSubagentAllowed(event.input);
      if (reason) {
        return { block: true, reason };
      }
    }
  });

  // 注入型消息：每种类型只保留最新一条，避免历史消息永久累积浪费 token
  pi.on("context", async (event) => {
    const seen = new Set<string>();
    const filtered: typeof event.messages = [];
    // plan-mode-context 特殊处理：保留内容最长的一条（完整规则块）而不是最新一条——
    // 第二轮起注入的短句 "保持相同规则" 若替换掉规则块，模型上下文即丢失规则原文
    // （审计 MEDIUM）。其余注入类型保持"每种最新一条"防累积。
    let bestRule: (AgentMessage & { customType?: string; content?: string }) | null = null
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      const msg = m as AgentMessage & { customType?: string; content?: string };
      const customType = msg.customType;
      if (customType && INJECTED_CUSTOM_TYPES.has(customType)) {
        if (customType === "plan-mode-context") {
          if (!bestRule || (msg.content?.length ?? 0) > (bestRule.content?.length ?? 0)) {
            bestRule = msg
          }
          continue
        }
        if (seen.has(customType)) continue;
        seen.add(customType);
      }
      filtered.unshift(m);
    }
    // 规则块放上下文末尾（与 before_agent_start 注入位置一致）
    if (bestRule) filtered.push(bestRule as typeof event.messages[number])
    return { messages: filtered };
  });

  // Inject plan/execution context before agent starts
  pi.on("before_agent_start", async () => {
    if (state.planModeEnabled) {
      // 计划模式压缩恢复标记（审计 L3）：本分支提前 return，后面的
      // compaction-recovery（P1）不可达 → 这里补消费，否则 _ctx.just_compacted 常驻
      {
        const n = loadNotes();
        if (n["_ctx.just_compacted"] === "true") clearCompactionFlag();
      }
      const pressureTag = getTokenPressureTag() || "";
      const preamble = pressureTag ? `${pressureTag}\n` : "";
      const content = state.planModeFullInjected
        ? `${preamble}[PLAN MODE] 保持相同规则。使用 /plan 退出。`
        : `${preamble}[PLAN MODE ACTIVE]
你处于规划模式 - 一种用于安全代码分析的只读探索模式。

限制:
- 只能使用: read, bash, grep, glob, todo, web_search, fetch_url, subagent, plan_exit
- 不能使用: edit, write（文件修改已禁用）
- Bash 命令仅接受白名单内的单条只读命令：cat/head/tail/less/more/grep/find/ls/lsblk/pwd/echo/printf/wc/sort/uniq/diff/file/stat/du/df/tree/which/whereis/type/uname/whoami/id/date/cal/uptime/ps/top/htop/free/awk/jq/rg/fd/bat/eza/sed -n、git status/log/diff/show/branch/remote/config、git ls-*、npm list/ls/view/info/search/outdated/audit、yarn list/info/why/audit、curl 仅打印、wget -O -、node/python --version 等。
- web_search 可搜索网络资料辅助调研；fetch_url 可拉取远程文档/API 数据（只读 HTTP GET）；subagent 仅允许 agent="scout"（只读调研子代理），worker/reviewer 与未指定 agent 均不可用（未指定会落到可写 general-purpose）。
- 探索完成且用户同意后，可调用 plan_exit 请求退出计划模式（系统会弹确认选择器，用户确认后生效；取消则保持只读）。
- 允许 cd <目录> && <一条白名单只读命令> 与命令尾部的 2>/dev/null；其余复合一律禁止：多命令分号 ;、管道 |、重定向至文件。
- 禁止: git clone、curl -o/-O（落盘）、写入类命令。
- 远程仓库分析请用 git ls-remote / git log / git status（有白名单），不要 clone。

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

计划步骤跟踪（重要）:
- 展示 Plan 块后，必须调用 todo 工具创建每个步骤（todo create subject="..."），用工具而非文本跟踪状态。
- 每完成一步立即调用 todo update id=N status=completed；开始某步时 todo update id=N status=in_progress。
- 修订计划时用 todo update 调整现有步骤（subject/status），禁止重复创建相同步骤。

不要尝试修改文件——只描述你要做什么。

计划展示后: 如果用户提出正常的后续问题
（为什么、是什么、解释一下），用文字回答——不要输出另一个 Plan: 块。
只有在用户明确要求修改、变更或更新时，才输出修订后的 "Plan:" 部分。`;
      state.planModeFullInjected = true;
      return {
        message: {
          customType: "plan-mode-context",
          content,
          display: false,
        },
      };
    }

    if (state.executionMode) {
      const curState = getState();
      const visible = curState.tasks.filter((t) => t.status !== "deleted");
      const currentHash = todoHash();
      if (visible.length > 0 && currentHash !== state.knownTodoHash) {
        state.knownTodoHash = currentHash;
        const pressureTag = getTokenPressureTag() || "";
        const preamble = pressureTag ? `${pressureTag}\n` : "";
        const remaining = visible.filter((t) => t.status !== "completed");
        const counts = selectTodoCounts(curState);
        // 状态标记与 plan.md 同格式（- [~] = 进行中），in_progress 附 activeForm
        const statusMark: Record<string, string> = {
          pending: " ",
          in_progress: "~",
          blocked: "b",
          completed: "x",
        };
        const todoList = remaining
          .map((t) => {
            const form =
              t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
            return `- [${statusMark[t.status] ?? " "}] ${t.id}. ${t.subject}${form}`;
          })
          .join("\n");
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

    // 注入技能指引（仅一次，动态扫描探活）：清单本体由核心 <available_skills> 提供
    // （名称+描述+路径），此处不再重复罗列（去重省 ~600 token/会话），仅补 /skill:name 用法提示
    if (!state.skillsInjected) {
      state.skillsInjected = true;
      const skills = discoverSkills();
      if (skills.length > 0) {
        return {
          message: {
            customType: "plan-skill-list",
            content: `[可用技能] 清单与触发条件见系统提示 <available_skills>；需求匹配时提示用户使用对应技能或回复 /skill:name。`,
            display: false,
          },
        };
      }
    }

    // 执行模式：todo 未变化时仅注入压力标签
    if (state.executionMode) {
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
  let lastTurnToolActivity = false;
  let lastTurnTodoActivity = false;
  let turnsSinceCleanup = 0;

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "todo") lastTurnTodoActivity = true;
    else lastTurnToolActivity = true;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!state.executionMode) return;
    if (!isAssistantMessage(event.message)) return;

    // 实时进度：任务状态变化时发一条精简进度消息（仅保留最新，不刷屏）
    const curState = getState();
    const currentHash = todoHash();
    if (currentHash !== state.knownTodoHash) {
      state.knownTodoHash = currentHash;
      const visible = curState.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0) {
        const counts = selectTodoCounts(curState);
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
    state.todoOverlay?.update();
    persistState();
  });

  pi.on("agent_end", async (event, ctx) => {
    // 清理提醒计数（所有模式累计）：存在 completed 任务则轮数 +1，无则归零。
    // 普通模式 ≥3 轮且本轮未碰 todo 时注入温和提醒（执行模式有 planComplete
    // 通知、计划模式有 overlay 呈现，不重复打扰）。
    const curState = getState();
    const curVisible = curState.tasks.filter((t) => t.status !== "deleted");
    const cleanup = cleanupReminderCheck(turnsSinceCleanup, lastTurnTodoActivity, curVisible);
    turnsSinceCleanup = cleanup.turns;
    if (cleanup.remind && !state.planModeEnabled && !state.executionMode) {
      // 任务清理提醒：completed 任务滞留 ≥3 轮未 delete/clear（模型可能完成后
      // 忘记归档）。温和提醒，不主动改状态；提醒后计数归零（忽略则 3 轮后再提醒）。
      pi.sendMessage(
        {
          customType: "plan-mode-recovery",
          content: `[任务清理提醒] ${cleanup.done} 个任务已完成但连续 ≥3 轮未清理。已完成任务用 todo delete id=N 归档，或 /plan clear 一键清空。`,
          display: false,
        },
        { triggerTurn: false },
      );
    }

    // 执行模式：检测计划修订——修订意图必须来自用户消息（assistant 汇报/总结含"修订"等词不触发）
    if (state.executionMode) {
      const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
      const userText = lastUser ? getUserText(lastUser) : "";
      const lastAssistant = [...event.messages]
        .reverse()
        .find(isAssistantMessage);
      const lastText = lastAssistant ? getTextContent(lastAssistant) : "";
      const extracted = lastText ? extractTodoItems(lastText) : [];
      if (extracted.length > 0 && isPlanRevisionIntent(userText)) {
        const { tasks, nextId, added, removed } = mergePlanRevision(
          getState(),
          extracted,
        );
        replaceState({ tasks, nextId });
        persistState();
        state.knownTodoHash = todoHash();
        updateStatus(ctx);
        state.todoOverlay?.update();
        const summary = [
          added.length > 0 ? `${added.length} 个新步骤` : "",
          removed.length > 0 ? `${removed.length} 个旧步骤已移除` : "",
        ]
          .filter(Boolean)
          .join("，");
        pi.sendMessage(
          {
            customType: "plan-revise",
            content: `**计划已修订**${summary ? ` — ${summary}` : ""}：\n\n${extracted
              .map((t) => `${t.id}. ${t.subject}`)
              .join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
      }

      const curState = getState();
      const visible = curState.tasks.filter((t) => t.status !== "deleted");
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
        state.executionMode = false;
        restoreAllTools(pi);
        updateStatus(ctx);
        state.todoOverlay?.update();
        persistState();
      } else if (lastTurnToolActivity && !lastTurnTodoActivity) {
        // 任务状态校验提醒：本轮有工具操作但完全没碰 todo 工具（模型可能在
        // 干活却忘记同步任务状态）。温和提醒核对（不主动改状态）；模型主动
        // 更新过 todo 则不打扰。低频：同一轮不重复、计划模式不提醒。
        const pending = visible.filter((t) => t.status !== "completed");
        if (pending.length > 0) {
          const done = visible.filter((t) => t.status === "completed").length;
          pi.sendMessage(
            {
              customType: "plan-mode-recovery",
              content: `[任务状态提醒] 上轮有工具操作但未调用 todo 工具同步状态（${done}/${visible.length} 完成）。请调用 todo 工具核对：已完成用 todo update id=N status=completed，未完成的保持 in_progress 并继续。`,
              display: false,
            },
            { triggerTurn: false },
          );
        }
      }
      lastTurnToolActivity = false;
      lastTurnTodoActivity = false;
      return;
    }

    if (!state.planModeEnabled || !ctx.hasUI) return;

    // Extract todos from last assistant message
    const lastAssistant = [...event.messages]
      .reverse()
      .find(isAssistantMessage);
    if (lastAssistant) {
      const lastText = getTextContent(lastAssistant);
      const extracted = extractTodoItems(lastText);
      if (extracted.length > 0) {
        // 修订意图来自用户消息（首次呈现或用户明确要求修改时重建）
        const lastUser = [...event.messages].reverse().find((m) => m.role === "user");
        const userText = lastUser ? getUserText(lastUser) : "";
        const isNewPlan = !state.planPresented || isPlanRevisionIntent(userText);

        if (isNewPlan) {
          // 修订替换语义：匹配保留原任务（含状态），未匹配 pending 移除，新步骤追加
          const { tasks, nextId } = mergePlanRevision(getState(), extracted);
          replaceState({ tasks, nextId });

          // Save plan to git repo
          let iteration = 1;
          if (state.planDir) {
            const { stdout } = await runGit(pi, state.planDir, "git rev-list --count HEAD");
            const count = Number(stdout.trim());
            iteration = Number.isFinite(count) && count > 0 ? count + 1 : 2;
          }
          const saveGen = ++state.planSaveGen
          savePlanIteration(lastText, iteration).then((dir) => {
            // 代次守卫：仅最新一次修订的回调可写 planDir（旧回调晚到直接丢弃）
            if (saveGen !== state.planSaveGen) return
            state.planDir = dir;
            persistState();
          }).catch((err) => {
            console.error("plan-mode: Failed to save plan iteration:", err);
          });
        }
        state.planPresented = true;
      }

      // Capture Q&A pair when plan has been presented
      if (state.planPresented) {
        const lastUser = [...event.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (lastUser) {
          const userContent = getUserText(lastUser);
          if (userContent.trim()) {
            state.qaMessages.push({ role: "user", content: userContent });
          }
        }
        state.qaMessages.push({
          role: "assistant",
          content: lastText.slice(0, 500),
        });

        if (state.qaMessages.length > 6) {
          state.qaMessages = state.qaMessages.slice(-6);
        }
      }
    }

    // Only show choice when todos actually changed or plan is brand new
    const finalState = getState();
    const visible = finalState.tasks.filter((t) => t.status !== "deleted");
    const needsChoice = visible.length > 0 && todoHash() !== state.knownTodoHash;
    if (!needsChoice) return;

    // Show plan steps (仅在计划有变化时展示，避免重复刷屏)
    if (visible.length > 0) {
      const counts = selectTodoCounts(curState);
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
      state.planModeEnabled = false;
      state.executionMode = visible.length > 0;
      state.knownTodoHash = todoHash();
      restoreAllTools(pi);
      updateStatus(ctx);
      state.todoOverlay?.update();

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
        // deliverAs:'followUp'（2026-08-30）：主会话 streaming 中裸调用会抛 "Agent is already processing"
        pi.sendUserMessage(refinement.trim(), { deliverAs: 'followUp' });
      }
    } else {
      // 继续计划模式（或取消选择）：确认当前任务状态，避免下一轮重复弹选择器
      state.knownTodoHash = todoHash();
    }
  });

  // Restore state on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    cleanupOldPlans();
    resetBudget();
    const { resetState } = await import("./store.ts");
    resetState();

    if (pi.getFlag("plan") === true) {
      state.planModeEnabled = true;
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
      // --plan 启动标志优先：持久化 enabled=false 不覆盖显式启动
      state.planModeEnabled = resolvePlanModeEnabled(
        pi.getFlag("plan") as boolean | undefined,
        planModeEntry.data.enabled,
        state.planModeEnabled,
      );
      state.executionMode = planModeEntry.data.executing ?? state.executionMode;
      state.planPresented = planModeEntry.data.planPresented ?? state.planPresented;
      state.planDir = planModeEntry.data.planDir ?? state.planDir;
      state.qaMessages = planModeEntry.data.qaMessages ?? state.qaMessages;

      if (planModeEntry.data.tasks) {
        replaceState({
          tasks: planModeEntry.data.tasks,
          nextId: planModeEntry.data.nextId ?? 1,
        });
      }
    }

    // P1: /clear 或会话切换导致 sessionTree 无 plan-mode 数据时，
    // 从最新计划文件恢复任务列表（磁盘持久化兜底）。
    // 只恢复任务状态，不强制进入执行模式（避免新会话工具集受限 + 跨项目计划被接管）：
    // 任务以普通模式显示，用户 /plan resume 主动继续执行；
    // planDir 不绑定旧目录（防 syncPlanToFile 污染其他项目的计划文件）。
    if (!planModeEntry?.data?.tasks) {
      const { restoreStateFromFile } = await import("./helpers.ts");
      const restored = await restoreStateFromFile();
      if (restored) {
        replaceState(restored);
        // 审计 MEDIUM：磁盘兑底命中时无条件 false 会静默覆盖 --plan 启动标志——
        // 与 resolvePlanModeEnabled 同语义：显式 --plan 启动优先
        state.planModeEnabled = pi.getFlag("plan") === true;
        state.executionMode = false;
        state.planDir = null;
      }
    }

    // Restore overlay UI
    if (ctx.hasUI) {
      state.todoOverlay ??= new TodoOverlay();
      state.todoOverlay.setUICtx(ctx.ui);
      state.todoOverlay.resetCompletedDisplayState();
      state.todoOverlay.update();
    }

    // On resume: re-scan messages to rebuild completion state
    const isResume = planModeEntry !== undefined;
    if (isResume && state.executionMode) {
      const curState = getState();
      const visible = curState.tasks.filter((t) => t.status !== "deleted");
      if (visible.length > 0) {
        updateStatus(ctx);
        state.todoOverlay?.update();
      }
    }

    if (state.planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    } else if (!state.executionMode) {
      // 普通会话工具快照修复：重启/热载后会话 tools 快照不含新注册的扩展工具
      // （如 plan_enter），模型不可见。非计划/非执行模式时用全量工具重建。
      // 执行计划分支已改 restoreAllTools 全量恢复，此处自愈检查仅兑底。
      const active = pi.getActiveTools();
      if (active.length === 0 || !active.includes("plan_enter")) {
        restoreAllTools(pi);
      }
    }
    updateStatus(ctx);
  });

  // Overlay lifecycle handlers
  pi.on("session_compact", async (_event, ctx) => {
    state.todoOverlay?.resetCompletedDisplayState();
    state.todoOverlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    state.todoOverlay?.resetCompletedDisplayState();
    state.todoOverlay?.update();
  });

  pi.on("session_shutdown", async () => {
    state.todoOverlay?.dispose();
    state.todoOverlay = undefined;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (event.toolName !== "todo" || event.isError) return;
    // 清理动作（delete/clear）重置清理提醒计数（action 不在 arguments 时可选链兜底）
    const action = (event as { arguments?: { action?: string } }).arguments?.action;
    if (action === "delete" || action === "clear") turnsSinceCleanup = 0;
    // 普通模式直接 todo 创建/更新时确保 overlay 存在（首次创建于 updateStatus）
    if (ctx.hasUI) {
      state.todoOverlay ??= new TodoOverlay();
      state.todoOverlay.setUICtx(ctx.ui);
    }
    state.todoOverlay?.update();
    // 状态条即时刷新：todo 状态变化发生在消息事件之后，若不在此更新，
    // 📋 n/m 状态条要等下一轮消息事件才刷新（滞后一轮）
    updateStatus(ctx);
    // 状态持久化：普通模式 todo 变更不经过 /plan 命令，不调 persistState 则
    // 重启丢失任务（appendEntry + 执行模式 plan.md 同步；hash 去重防重复写）
    persistState();
  });

  pi.on("agent_start", async () => {
    state.todoOverlay?.hideCompletedTasksFromPreviousTurn();
    // 每轮开始前按模式强制刷新工具集：--continue 恢复会话的工具快照可能不含
    // 新注册工具（plan_enter/plan_exit），本轮 snapshot 已定、下一轮生效。
    // 计划模式用白名单；执行/普通模式用全量（含全部扩展工具）。
    try {
      if (state.planModeEnabled) {
        pi.setActiveTools(PLAN_MODE_TOOLS);
      } else {
        const active = pi.getActiveTools();
        if (active.length === 0 || !active.includes("plan_enter")) {
          const all = pi.getAllTools().map((t) => t.name);
          pi.setActiveTools(all);
        }
      }
    } catch {
      // runtime 未激活时跳过
    }
  });
}
