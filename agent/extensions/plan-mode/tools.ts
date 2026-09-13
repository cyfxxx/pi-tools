import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { restoreAllTools } from "./helpers.ts";
import { getState, resetState } from "./store.ts";
import { selectTodoCounts } from "./selectors.ts";
import { truncateSubject } from "./utils.ts";
import { persistState } from "./index.ts";

export const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "todo", "web_search", "fetch_url", "subagent", "plan_exit", "ask_user"];

export function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "向用户提问",
    description:
      "向用户提问并获取选择回答。当需要用户决策、确认下一步操作、或获取用户偏好时使用此工具。返回用户选择的选项标签，或用户输入的补充说明。",
    promptSnippet: "向用户提问并获取选择回答",
    promptGuidelines: [
      "需要用户决策时使用此工具。问题应清晰明确，选项应互斥且完整。",
      "选项标签应简洁（1-5个词），描述可选但建议提供以帮助用户理解。",
      "工具返回用户选择的选项标签，或用户输入的补充说明（以「其他:」开头）。",
      "如用户选择「其他（请说明）」，工具直接返回用户输入的内容，无需二次确认。",
    ],
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "问题内容",
        },
        header: {
          type: "string",
          description: "简短标签（显示在选择器标题）",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "选项标签（简洁，1-5个词）",
              },
              description: {
                type: "string",
                description: "选项描述（可选，帮助用户理解）",
              },
            },
            required: ["label"],
          },
          description: "选项数组（至少2个选项）",
        },
        multiple: {
          type: "boolean",
          description: "是否允许多选（默认false）",
        },
      },
      required: ["question", "options"],
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { question, header, options, multiple } = params as {
        question: string;
        header?: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
      };

      // 验证参数
      if (!question || typeof question !== "string") {
        return {
          content: [{ type: "text" as const, text: "Error: question is required" }],
          details: null,
          isError: true,
        };
      }

      if (!Array.isArray(options) || options.length < 2) {
        return {
          content: [{ type: "text" as const, text: "Error: options must be an array with at least 2 items" }],
          details: null,
          isError: true,
        };
      }

      const OTHER_OPTION = "其他（请说明）";
      const optionLabels = [...options.map((opt) => opt.label), OTHER_OPTION];
      const title = header ? `${header}: ${question}` : question;

      // 单选模式
      if (!multiple) {
        while (true) {
          const choice = await ctx.ui.select(title, optionLabels);

          if (choice === undefined) {
            return {
              content: [{ type: "text" as const, text: "用户取消了选择" }],
              details: null,
            };
          }

          // 用户选择"其他"：直接弹出输入框
          if (choice === OTHER_OPTION) {
            const reason = await ctx.ui.editor("请说明你的选择：", "");
            if (reason && reason.trim()) {
              return {
                content: [{ type: "text" as const, text: `其他: ${reason.trim()}` }],
                details: null,
              };
            }
            // 用户未输入，继续循环
            continue;
          }

          // 用户选择具体选项：直接返回，无需二次确认
          return {
            content: [{ type: "text" as const, text: choice }],
            details: null,
          };
        }
      }

      // 多选模式：支持选择/取消单个选项，直到选择"完成"
      const selected: string[] = [];
      
      while (true) {
        // 构建选项列表：已选选项（带✓标记）+ 未选选项 + "其他（请说明）" + "完成选择" + "取消全部"
        const selectedOptions = selected.map((label) => `✓ ${label}`);
        const availableOptions = options.map((opt) => opt.label).filter((label) => !selected.includes(label));
        const selectOptions = [...selectedOptions, ...availableOptions, OTHER_OPTION, "完成选择", "取消全部"];
        
        const choice = await ctx.ui.select(title, selectOptions);

        if (choice === undefined) {
          return {
            content: [{ type: "text" as const, text: "用户取消了选择" }],
            details: null,
          };
        }

        if (choice === "完成选择") {
          if (selected.length === 0) {
            continue;
          }
          return {
            content: [{ type: "text" as const, text: selected.join(", ") }],
            details: null,
          };
        }

        if (choice === "取消全部") {
          selected.length = 0;
          continue;
        }

        // 用户选择"其他"：直接弹出输入框
        if (choice === OTHER_OPTION) {
          const reason = await ctx.ui.editor("请说明你的补充信息：", "");
          if (reason && reason.trim()) {
            // 多选模式下，将补充信息追加到已选列表
            selected.push(`其他: ${reason.trim()}`);
          }
          continue;
        }

        // 处理选择/取消：移除 ✓ 前缀获取实际标签
        const actualLabel = choice.startsWith("✓ ") ? choice.slice(2) : choice;
        
        if (selected.includes(actualLabel)) {
          const index = selected.indexOf(actualLabel);
          selected.splice(index, 1);
        } else {
          selected.push(actualLabel);
        }
      }
    },
  });
}

export function registerPlanEnterTool(
  pi: ExtensionAPI,
  state: {
    planModeEnabled: boolean;
    executionMode: boolean;
    planModeFullInjected: boolean;
    planPresented: boolean;
    planDir: string | null;
    qaMessages: import("./helpers.ts").QAPair[];
    knownTodoHash: number;
  },
  updateStatus: (ctx: ExtensionContext) => void,
): void {
  // 模型侧计划模式切换工具（参考 opencode plan_enter/plan_exit 权限设计）：
  // plan_enter 仅执行模式白名单可见（模型可主动进入只读探索）；
  // plan_exit 仅计划模式白名单可见（模型探索完可主动退出恢复写权限）。
  // 与用户侧 /plan、Ctrl+Alt+P 等价，但由模型在对话中主动触发。
  pi.registerTool({
    name: "plan_enter",
    label: "进入计划模式",
    description:
      '进入计划模式（只读探索）：工具集切为只读白名单（无 edit/write，bash 仅白名单命令），可安全调研后制定计划。已在计划模式时无操作。',
    promptSnippet: "进入计划模式（只读探索）",
    promptGuidelines: [
      "适合需要先安全调研再动手的复杂任务：进入计划模式后用 read/bash/grep 探索代码、web_search/fetch_url 查资料、subagent(agent=scout) 并行调研，再用 todo 建立计划步骤。",
      "计划完成且用户同意后，调用 plan_exit 退出计划模式恢复编辑权限。",
    ],
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (state.planModeEnabled) {
        return { content: [{ type: "text" as const, text: "已在计划模式（只读）。" }], details: null };
      }
      state.planModeEnabled = true;
      state.executionMode = false;
      state.planModeFullInjected = false;
      resetState();
      state.planPresented = false;
      state.planDir = null;
      state.qaMessages = [];
      state.knownTodoHash = 0;
      pi.setActiveTools(PLAN_MODE_TOOLS);
      ctx.ui.notify(`规划模式已启用（模型主动）。工具: ${PLAN_MODE_TOOLS.join(", ")}`);
      updateStatus(ctx);
      return {
        content: [{ type: "text" as const, text: `已进入计划模式（只读）。可用工具: ${PLAN_MODE_TOOLS.join(", ")}。探索完成后可调用 plan_exit 退出。` }],
        details: null,
      };
    },
  });
}

export function registerPlanExitTool(
  pi: ExtensionAPI,
  state: {
    planModeEnabled: boolean;
    executionMode: boolean;
    planModeFullInjected: boolean;
    planPresented: boolean;
  },
  updateStatus: (ctx: ExtensionContext) => void,
): void {
  pi.registerTool({
    name: "plan_exit",
    label: "退出计划模式",
    description: '请求退出计划模式，恢复执行模式（可编辑文件、完整工具集）。计划任务保留（/plan todos 查看，/plan resume 继续执行）。退出需用户手动确认：弹出选择器后确认生效，取消则保持计划模式。不在计划模式时无操作。',
    promptSnippet: "退出计划模式（需用户确认）",
    promptGuidelines: ["退出前先向用户说明计划完成情况与后续执行意向；调用本工具后等待用户确认，用户取消则继续计划模式。"],
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!state.planModeEnabled) {
        return { content: [{ type: "text" as const, text: "不在计划模式。" }], details: null };
      }
      // 退出必须用户手动确认（参考 opencode plan_exit 的用户询问语义）
      const choice = await ctx.ui.select("模型请求退出计划模式（恢复编辑权限）？", ["确认退出", "取消（继续计划模式）"]);
      if (choice !== "确认退出") {
        ctx.ui.notify("已取消退出计划模式，保持只读。");
        // 用户选择继续计划模式：中止当前生成，交还输入权——模型不再继续输出，等待用户输入
        ctx.abort();
        return {
          content: [{ type: "text" as const, text: "用户取消了退出请求，继续保持计划模式（只读）。等待用户输入。" }],
          details: null,
        };
      }
      state.planModeEnabled = false;
      state.executionMode = true;
      state.planModeFullInjected = false;
      state.planPresented = false;
      restoreAllTools(pi);
      persistState();
      ctx.ui.notify("规划模式已禁用（用户确认）。完整权限已恢复。");
      updateStatus(ctx);
      const curState = getState();
      const count = curState.tasks.filter((t) => t.status !== "deleted").length;
      return {
        content: [
          {
            type: "text" as const,
            text: count > 0
              ? `用户已确认退出计划模式，恢复完整权限。保留 ${count} 项计划任务（/plan todos 查看，/plan resume 继续执行）。`
              : "用户已确认退出计划模式，恢复完整权限。",
          },
        ],
        details: null,
      };
    },
  });
}
