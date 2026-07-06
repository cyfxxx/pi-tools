import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyTaskMutation, type TaskAction, type TaskMutationParams } from "./state.ts";
import { commitState, getState } from "./store.ts";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./selectors.ts";
import { formatCommandTaskLine, formatGetLines, formatListLine } from "./view.ts";

function validateParams(params: Record<string, unknown>): string | null {
  const action = params.action;
  if (!action || !["create", "update", "list", "get", "delete", "clear"].includes(action as string)) {
    return "action required: create, update, list, get, delete, or clear";
  }
  return null;
}

export function registerTodoTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "计划任务",
    description:
      "管理任务列表以跟踪多步骤进度。操作: create（新建任务）、update（更新状态/字段）、list（列出任务）、get（查看详情）、delete（删除/归档）、clear（重置）。状态: pending → in_progress → completed，delete 作为归档。使用此工具规划和跟踪多步骤工作。",
    promptSnippet: "管理任务列表以跟踪多步骤进度",
    promptGuidelines: [
      "用 todo 管理多步骤任务。create 创建、update status=in_progress activeForm='正在...' 开始、update status=completed 完成。每次只有一个 in_progress。",
      "状态机: pending → in_progress → completed。delete 归档已完成或取消的任务。",
      "遇到阻塞或错误时保持当前任务 in_progress，创建新任务处理阻塞。不要跳过步骤标记 completed。",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "操作类型",
          enum: ["create", "update", "list", "get", "delete", "clear"],
        },
        subject: {
          type: "string",
          description: "任务标题（create 必填）",
        },
        description: {
          type: "string",
          description: "任务详细描述",
        },
        activeForm: {
          type: "string",
          description: "进行中状态的标签（如 '正在编写测试'）",
        },
        status: {
          type: "string",
          description: "目标状态（update 用）或过滤条件（list 用）",
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        id: {
          type: "number",
          description: "任务 ID（update/get/delete 必填）",
        },
        includeDeleted: {
          type: "boolean",
          description: "list 时是否包含已归档的任务",
        },
        owner: {
          type: "string",
          description: "负责人",
        },
      },
      required: ["action"],
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const err = validateParams(params);
      if (err) {
        return { content: [{ type: "text", text: `Error: ${err}` }] };
      }

      const action = params.action as TaskAction;
      const result = applyTaskMutation(getState(), action, params as TaskMutationParams);
      commitState(result.state);

      const text = formatContent(result.op, result.state);
      if (result.op.kind === "error") {
        return { content: [{ type: "text", text: `Error: ${text}` }] };
      }
      return { content: [{ type: "text", text }] };
    },
  });
}

function formatContent(op: ReturnType<typeof applyTaskMutation>["op"], state: ReturnType<typeof getState>): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      return t ? `已创建 #${t.id}: ${t.subject} (${statusLabel(t.status)})` : `已创建 #${op.taskId}`;
    }
    case "update": {
      const transition = op.fromStatus !== op.toStatus ? ` (${statusLabel(op.fromStatus)} → ${statusLabel(op.toStatus)})` : "";
      return `已更新 #${op.id}${transition}`;
    }
    case "delete":
      return `已删除 #${op.id}: ${op.subject}`;
    case "clear":
      return `已清空 ${op.count} 个任务`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0 ? "暂无任务" : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task);
    case "error":
      return op.message;
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待办",
    in_progress: "进行中",
    completed: "已完成",
    deleted: "已删除",
  };
  return labels[status] ?? status;
}

export function registerTodosCommand(pi: ExtensionAPI): void {
  pi.registerCommand("todos", {
    description: "按状态分组显示所有计划任务",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/todos 需要交互模式", "error");
        return;
      }
      const state = getState();
      const visible = selectVisibleTasks(state);
      if (visible.length === 0) {
        ctx.ui.notify("暂无计划任务。请先让 Agent 创建计划。", "info");
        return;
      }
      const groups = selectTasksByStatus(state);
      const counts = selectTodoCounts(state);

      const header: string[] = [];
      if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} 已完成`);
      if (counts.inProgress > 0) header.push(`${counts.inProgress} 进行中`);
      if (counts.pending > 0) header.push(`${counts.pending} 待办`);

      const lines: string[] = [header.join(" · ")];
      if (groups.pending.length > 0) {
        lines.push("── 待办 ──");
        for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
      }
      if (groups.inProgress.length > 0) {
        lines.push("── 进行中 ──");
        for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
      }
      if (groups.completed.length > 0) {
        lines.push("── 已完成 ──");
        for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
