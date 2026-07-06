export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

export type Op =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

export interface TaskMutationParams {
  [key: string]: unknown;
  action?: TaskAction;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  id?: number;
  includeDeleted?: boolean;
  owner?: string;
}

export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
): ApplyResult {
  switch (action) {
    case "create": {
      if (!params.subject?.trim()) {
        return errorResult(state, "subject required for create");
      }
      const newTask: Task = {
        id: state.nextId,
        subject: params.subject,
        status: "pending",
      };
      if (params.description) newTask.description = params.description;
      if (params.activeForm) newTask.activeForm = params.activeForm;
      if (params.owner) newTask.owner = params.owner;

      const newTasks = [...state.tasks, newTask];
      return {
        state: { tasks: newTasks, nextId: state.nextId + 1 },
        op: { kind: "create", taskId: newTask.id },
      };
    }

    case "update": {
      if (params.id === undefined) return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        params.owner !== undefined;
      if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

      let newStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
        }
        newStatus = params.status;
      }

      const updated: Task = { ...current, status: newStatus };
      if (params.subject !== undefined) updated.subject = params.subject;
      if (params.description !== undefined) updated.description = params.description;
      if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;

      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: updated.id,
          fromStatus: current.status,
          toStatus: newStatus,
        },
      };
    }

    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined ? { statusFilter: params.status } : {}),
        },
      };
    }

    case "get": {
      if (params.id === undefined) return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined) return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
      const updated: Task = { ...current, status: "deleted" };
      const newTasks = [...state.tasks];
      newTasks[idx] = updated;
      return {
        state: { tasks: newTasks, nextId: state.nextId },
        op: { kind: "delete", id: updated.id, subject: updated.subject },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return {
        state: { tasks: [], nextId: 1 },
        op: { kind: "clear", count },
      };
    }
  }
}
