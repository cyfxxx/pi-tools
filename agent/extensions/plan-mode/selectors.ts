import type { Task } from "./state.ts";
import type { TaskState } from "./state.ts";

export function selectVisibleTasks(state: TaskState): readonly Task[] {
  return state.tasks.filter((t) => t.status !== "deleted");
}

export interface TasksByStatus {
  pending: readonly Task[];
  inProgress: readonly Task[];
  completed: readonly Task[];
}

export function selectTasksByStatus(state: TaskState): TasksByStatus {
  const visible = selectVisibleTasks(state);
  return {
    pending: visible.filter((t) => t.status === "pending"),
    inProgress: visible.filter((t) => t.status === "in_progress"),
    completed: visible.filter((t) => t.status === "completed"),
  };
}

export interface TodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export function selectTodoCounts(state: TaskState): TodoCounts {
  const groups = selectTasksByStatus(state);
  return {
    total: groups.pending.length + groups.inProgress.length + groups.completed.length,
    pending: groups.pending.length,
    inProgress: groups.inProgress.length,
    completed: groups.completed.length,
  };
}

export interface OverlayLayout {
  visible: readonly Task[];
  hiddenCompleted: number;
  truncatedTail: number;
}

export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
  const all = selectVisibleTasks(state);
  if (all.length <= budget) {
    return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const innerBudget = budget - 1;
  const nonCompleted = all.filter((t) => t.status !== "completed");
  const totalCompleted = all.length - nonCompleted.length;
  if (nonCompleted.length <= innerBudget) {
    const kept = new Set<Task>(nonCompleted);
    for (const t of all) {
      if (kept.size >= innerBudget) break;
      if (t.status === "completed") kept.add(t);
    }
    const visible = all.filter((t) => kept.has(t));
    const shownCompleted = visible.filter((t) => t.status === "completed").length;
    return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
  }
  const visible = nonCompleted.slice(0, innerBudget);
  const truncatedTail = nonCompleted.length - innerBudget;
  return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}

export function selectHasActive(state: TaskState): boolean {
  return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}
