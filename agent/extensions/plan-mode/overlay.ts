import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { getState } from "./store.ts";
import { selectHasActive, selectOverlayLayout, selectTodoCounts } from "./selectors.ts";
import { formatStatusLabel } from "./view.ts";

const WIDGET_KEY = "plan-todos";
const MAX_WIDGET_LINES = 12;

export class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private completedPendingHide = new Set<number>();
  private hiddenCompleted = new Set<number>();
  private lastNextId: number | undefined;

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = this.selectVisible(snapshot);

    // opencode todos 行为：全部完成时整个面板隐藏（status bar 仍显示完成态）
    if (visible.length === 0 || visible.every((t) => t.status === "completed")) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(theme, width),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  resetCompletedDisplayState(): void {
    this.completedPendingHide.clear();
    this.hiddenCompleted.clear();
    this.lastNextId = undefined;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    if (this.completedPendingHide.size === 0) return;
    for (const id of this.completedPendingHide) this.hiddenCompleted.add(id);
    this.completedPendingHide.clear();
    this.tui?.requestRender();
  }

  /** 注销 widget（保留 uiCtx 供后续重建）——供 updateStatus 在计划模式/任务清空时强制隐藏。 */
  hide(): void {
    if (this.widgetRegistered && this.uiCtx) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.resetCompletedDisplayState();
  }

  private getSnapshot() {
    const state = getState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.resetCompletedDisplayState();
    }
    this.lastNextId = state.nextId;
    const completedIds = new Set(state.tasks.filter((t) => t.status === "completed").map((t) => t.id));
    for (const id of this.completedPendingHide) {
      if (!completedIds.has(id)) this.completedPendingHide.delete(id);
    }
    for (const id of this.hiddenCompleted) {
      if (!completedIds.has(id)) this.hiddenCompleted.delete(id);
    }
    return [...state.tasks];
  }

  private selectVisible(tasks: ReturnType<TodoOverlay["getSnapshot"]>) {
    return tasks.filter((t) => t.status !== "deleted" && !(t.status === "completed" && this.hiddenCompleted.has(t.id)));
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const tasks = this.getSnapshot();
    const visible = this.selectVisible(tasks);
    if (visible.length === 0) return [];

    // 计数基于全量任务（含折叠的 completed/deleted 不计），进度感准确：
    // 完成 2/10 显示 (2/10) 而非按可见列表算 (0/8)
    const allState = { tasks, nextId: tasks.length ? Math.max(...tasks.map((t) => t.id)) + 1 : 1 };
    const counts = selectTodoCounts(allState);
    const hasActive = selectHasActive({ tasks: visible, nextId: 0 });

    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const headingText = `计划 (${counts.completed}/${counts.total})`;
    let heading = `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`;

    const active = visible.find((t) => t.status === "in_progress");
    if (active) {
      // heading.length 会把 CJK 按 1 列算，窄终端下会低估实际宽度；改用可见宽度估算剩余空间。
      const headingWidth = visibleWidth(heading);
      const maxSubject = Math.max(10, width - headingWidth - 14);
      const subject = truncateToWidth(active.subject, maxSubject, "…");
      heading += ` ${theme.fg("warning", `▶ ${subject}`)}`;
    }

    const lines: string[] = [heading];
    const layout = selectOverlayLayout({ tasks: visible, nextId: 0 }, MAX_WIDGET_LINES - 1);
    for (const task of layout.visible) {
      lines.push(this.formatCheckboxLine(task, theme, width));
    }

    for (const task of visible) {
      if (task.status === "completed" && !this.completedPendingHide.has(task.id) && !this.hiddenCompleted.has(task.id)) {
        this.completedPendingHide.add(task.id);
      }
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      return this.withTrailingSpacer(lines);
    }

    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const parts: string[] = [];
    if (layout.hiddenCompleted > 0) parts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
    if (layout.truncatedTail > 0) parts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
    const summary = totalHidden > 0 ? `+${totalHidden} 更多 (${parts.join(", ")})` : `+${totalHidden} 更多`;
    lines.push(`${theme.fg("dim", summary)}`);
    // 兜底保险：任意行超宽（含主题色前缀的可见宽度差）都截断到终端宽度，
    // 避免 pi-tui 渲染保护检测到 visibleWidth > width 直接抛异常终止进程（见 2026-08-17 崩溃）。
    return this.withTrailingSpacer(lines.map((l) => (l ? truncateToWidth(l, width, "…") : l)));
  }

  /** opencode todos 风格行：`[✓]`（完成/灰）/ `[•]`（进行中/黄）/ `[ ]`（待办/灰） */
  private formatCheckboxLine(task: { id: number; subject: string; status: "pending" | "in_progress" | "completed" | "blocked" | "deleted"; activeForm?: string }, theme: Theme, width: number): string {
    const check =
      task.status === "completed"
        ? "[✓]"
        : task.status === "in_progress"
          ? "[•]"
          : task.status === "blocked"
            ? "[⏸]"
            : "[ ]";
    const color = task.status === "in_progress" ? "warning" : "dim";
    const prefix = `${theme.fg(color, check)} `;
    const prefixWidth = visibleWidth(prefix);
    const form = task.status === "in_progress" && task.activeForm ? `(${task.activeForm})` : "";
    const formWidth = form ? visibleWidth(form) : 0;
    // subject 与 activeForm 共享剩余宽度，subject 优先；括号与空格留 3 列余量。
    const subjectAvail = Math.max(8, width - prefixWidth - (form ? formWidth + 3 : 0));
    const subject = truncateToWidth(task.subject, subjectAvail, "…");
    let line = `${theme.fg(color, check)} ${theme.fg(color, subject)}`;
    if (form) {
      const rest = Math.max(0, width - visibleWidth(line));
      if (rest >= formWidth + 1) {
        line += ` ${theme.fg("dim", form)}`;
      } else if (rest >= 3) {
        // 空间不足时截断 activeForm（最小保留 1 列 + 省略号）
        const clipped = truncateToWidth(form, Math.max(1, rest - 1), "…");
        line += ` ${theme.fg("dim", clipped)}`;
      }
    }
    return truncateToWidth(line, width, "…");
  }

  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    lines.push("");
    return lines;
  }
}
