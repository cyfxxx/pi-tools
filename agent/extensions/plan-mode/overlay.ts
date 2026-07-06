import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getState } from "./store.ts";
import { selectHasActive, selectOverlayLayout, selectTodoCounts } from "./selectors.ts";
import { formatOverlayTaskLine, formatStatusLabel } from "./view.ts";

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

    if (visible.length === 0) {
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

    const overlayState = { tasks: visible, nextId: tasks.length ? Math.max(...tasks.map((t) => t.id)) + 1 : 1 };
    const counts = selectTodoCounts(overlayState);
    const hasActive = selectHasActive(overlayState);

    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const headingText = `计划 (${counts.completed}/${counts.total})`;
    const heading = `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`;

    const lines: string[] = [heading];
    const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - 1);
    for (const task of layout.visible) {
      lines.push(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme)}`);
    }

    for (const task of visible) {
      if (task.status === "completed" && !this.completedPendingHide.has(task.id) && !this.hiddenCompleted.has(task.id)) {
        this.completedPendingHide.add(task.id);
      }
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace("├─", "└─");
      return this.withTrailingSpacer(lines);
    }

    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const parts: string[] = [];
    if (layout.hiddenCompleted > 0) parts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
    if (layout.truncatedTail > 0) parts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
    const summary = totalHidden > 0 ? `+${totalHidden} 更多 (${parts.join(", ")})` : `+${totalHidden} 更多`;
    lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`);
    return this.withTrailingSpacer(lines);
  }

  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    lines.push("");
    return lines;
  }
}
