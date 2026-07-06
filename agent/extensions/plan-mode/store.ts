import type { Task, TaskState } from "./state.ts";
import { EMPTY_STATE } from "./state.ts";

let _state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };

export function getTodos(): readonly Task[] {
  return _state.tasks;
}

export function getNextId(): number {
  return _state.nextId;
}

export function getState(): TaskState {
  return _state;
}

export function replaceState(next: TaskState): void {
  _state = next;
}

export function commitState(next: TaskState): void {
  _state = next;
}

export function resetState(): void {
  _state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
