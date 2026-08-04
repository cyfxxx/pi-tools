import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Task, TaskAction, TaskStatus } from "./state.ts";

export const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  blocked: "⏸",
  deleted: "⊘",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted" | "error"> = {
  pending: "dim",
  in_progress: "warning",
  completed: "success",
  blocked: "error",
  deleted: "muted",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "已阻塞",
  deleted: "已删除",
};

export function formatStatusLabel(status: TaskStatus): string {
  return STATUS_LABEL[status];
}

export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
  switch (status) {
    case "pending":
      return theme.fg("dim", "○");
    case "in_progress":
      return theme.fg("warning", "◐");
    case "completed":
      return theme.fg("success", "✓");
    case "blocked":
      return theme.fg("error", "⏸");
    case "deleted":
      return theme.fg("error", "✗");
  }
}

export function formatOverlayTaskLine(t: Task, theme: Theme): string {
  const glyph = overlayStatusGlyph(t.status, theme);
  const subjectColor =
    t.status === "completed" || t.status === "deleted" ? "dim" : "text";
  let subject = theme.fg(subjectColor, t.subject);
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  if (t.status === "blocked") {
    subject = theme.fg("error", t.subject);
  }
  let line = glyph;
  line += ` ${subject}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
  }
  return line;
}

export function formatCommandTaskLine(t: Task, glyph: string): string {
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  return `  ${glyph} #${t.id} ${t.subject}${form}`;
}

/** 聊天消息里的计划步骤行：opencode todos 风格勾选 + 截断名称 + 进行中表单 */
export function formatPlanMessageLine(t: Task, maxSubject = 40): string {
  const check =
    t.status === "completed" ? "[✓]" : t.status === "in_progress" ? "[•]" : t.status === "blocked" ? "[⏸]" : "[ ]";
  const subject =
    t.subject.length > maxSubject
      ? `${t.subject.slice(0, maxSubject - 1)}…`
      : t.subject;
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  return `${t.id}. ${check} ${subject}${form}`;
}

export function formatListLine(t: Task): string {
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  return `[${STATUS_LABEL[t.status]}] #${t.id} ${t.subject}${form}`;
}

export function formatGetLines(task: Task): string {
  const lines = [`#${task.id} [${STATUS_LABEL[task.status]}] ${task.subject}`];
  if (task.description) lines.push(`  描述: ${task.description}`);
  if (task.activeForm) lines.push(`  状态: ${task.activeForm}`);
  return lines.join("\n");
}
