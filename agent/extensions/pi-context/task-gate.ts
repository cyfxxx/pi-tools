import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// ── 压缩三重门限 ──
export const ABSOLUTE_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 256_000;
})();
export const RESTART_TOKENS = (() => {
  const raw = process.env.PI_CONTEXT_RESTART_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();
export const IDLE_MS = (() => {
  const raw = process.env.PI_CONTEXT_IDLE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
})();
export const TASK_GATE = process.env.PI_CONTEXT_TASK_GATE !== "off";
export const PLANS_DIR =
  process.env.PI_CONTEXT_PLANS_DIR ?? join(homedir(), ".pi", "plans");
export const COMPACT_COOLDOWN_MS = 10 * 60_000;

/** 本会话后台任务 registry 路径 */
export function tmuxRegistryPath(): string {
  return (
    process.env.PI_CONTEXT_TMUX_REGISTRY ||
    join(process.env.PI_HOME || homedir(), ".pi", "agent", "extensions", "pi-tmux", ".pi-tmux-registry.json")
  );
}

/** 门2b：本会话产生的后台任务 */
export function hasBackgroundTask(): boolean {
  try {
    const regPath = tmuxRegistryPath();
    if (!existsSync(regPath)) return false;
    const reg = JSON.parse(readFileSync(regPath, "utf8")) as {
      sessions?: Record<string, { owner?: string; name?: string }>
    };
    const owner = process.env.PI_SESSION_ID || "";
    if (!owner) return false;
    const names: string[] = [];
    for (const e of Object.values(reg.sessions ?? {})) {
      if (e.owner === owner && e.name) names.push(e.name);
    }
    if (names.length === 0) return false;
    let out = "";
    try {
      const r = spawnSync("tmux", ["list-sessions"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r.error || r.status !== 0) return false;
      out = String(r.stdout);
    } catch {
      return false;
    }
    return names.some((n) => out.split("\n").some((l) => l.startsWith(`${n}:`)));
  } catch {
    return false;
  }
}

/** 任务门 */
export function hasInProgressTask(): boolean {
  if (!TASK_GATE) return false;
  try {
    const dirs = readdirSync(PLANS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("plan-"))
      .map((d) => ({ name: d.name, ts: Number(d.name.replace("plan-", "")) }))
      .filter((d) => Number.isFinite(d.ts) && Date.now() - d.ts < 7 * 24 * 3600e3)
      .sort((a, b) => b.ts - a.ts);
    const latest = dirs.length > 0 ? dirs[0] : null;
    if (!latest) return false;
    const content = readFileSync(join(PLANS_DIR, latest.name, "plan.md"), "utf8");
    return /^\- \[~\]/m.test(content);
  } catch (e) {
    console.error("pi-context: task-gate read failed:", (e as Error).message);
  }
  return false;
}

/** 门2+门3 合并判定 */
export function taskAndIdleClear(
  lastUserTs: number,
  taskDoneAt: number,
): { clear: boolean; taskDoneAt: number } {
  let busy = hasInProgressTask();
  let localTaskDoneAt = taskDoneAt;
  // taskBusyPrev 由外部管理（需跨调用状态）
  // 这里简化：由调用方维护
  if (busy) return { clear: false, taskDoneAt: localTaskDoneAt };
  if (hasBackgroundTask()) return { clear: false, taskDoneAt: localTaskDoneAt };
  if (IDLE_MS <= 0) return { clear: true, taskDoneAt: localTaskDoneAt };
  const ref = Math.max(lastUserTs, localTaskDoneAt);
  if (ref <= 0) return { clear: true, taskDoneAt: localTaskDoneAt };
  return { clear: Date.now() - ref >= IDLE_MS, taskDoneAt: localTaskDoneAt };
}
