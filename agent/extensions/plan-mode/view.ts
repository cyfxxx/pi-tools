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
  const failed = t.failures && t.failures.length > 0 ? ` [!${t.failures.length}次失败]` : "";
  return `[${STATUS_LABEL[t.status]}] #${t.id} ${t.subject}${form}${failed}`;
}

export function formatGetLines(task: Task): string {
  const lines = [`#${task.id} [${STATUS_LABEL[task.status]}] ${task.subject}`];
  if (task.description) lines.push(`  描述: ${task.description}`);
  if (task.activeForm) lines.push(`  状态: ${task.activeForm}`);
  if (task.failures && task.failures.length > 0) {
    lines.push(`  已失败尝试:`);
    for (const f of task.failures) lines.push(`    - ${f}`);
  }
  return lines.join("\n");
}

/** P1: 任务状态渲染为 plan.md 文本（磁盘持久化，git 版本化）。 */
export function renderPlanFile(tasks: readonly Task[], nextId: number): string {
  const lines = [
    "# 计划（plan-mode 自动同步，勿手改——下一次状态变化会覆盖）",
    "",
  ];
  for (const t of tasks) {
    if (t.status === "deleted") continue;
    const check =
      t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : t.status === "blocked" ? "b" : " ";
    const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
    lines.push(`- [${check}] ${t.id}. ${t.subject}${form}`);
  }
  lines.push("");
  lines.push(`<!-- nextId: ${nextId} -->`);
  return lines.join("\n");
}

/** P1: 从 plan.md 文本解析任务状态；格式不符返回 null（防手改污染）。 */
export function parsePlanFile(content: string): { tasks: Task[]; nextId: number } | null {
  const tasks: Task[] = [];
  const lines = content.split("\n");
  let maxId = 0;
  let parsed = 0;
  for (const line of lines) {
    const m = line.match(/^- \[([ x~b])\] (\d+)\. (.+)$/);
    if (!m) continue;
    parsed++;
    const id = parseInt(m[2], 10);
    maxId = Math.max(maxId, id);
    const status =
      m[1] === "x" ? "completed" : m[1] === "~" ? "in_progress" : m[1] === "b" ? "blocked" : "pending";
    let subject = m[3];
    let activeForm: string | undefined;
    const fm = subject.match(/^(.+?)\s*\((.*)\)$/);
    if (fm && status === "in_progress") {
      subject = fm[1];
      activeForm = fm[2];
    }
    tasks.push({ id, subject, status, activeForm } as Task);
  }
  // 格式校验：至少 1 条可解析任务，且可解析行过半（防手改污染）
  const nonEmpty = lines.filter((l) => l.trim() !== "").length;
  if (parsed === 0 || parsed < nonEmpty / 2) return null;
  // nextId 优先取注释（保留删除任务后的游标），否则 maxId+1 推断
  const nextIdMatch = content.match(/<!-- nextId: (\d+) -->/);
  const nextId = nextIdMatch ? parseInt(nextIdMatch[1], 10) : maxId + 1;
  return { tasks, nextId };
}
