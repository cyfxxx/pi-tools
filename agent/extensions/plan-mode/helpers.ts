import { readdir, readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parsePlanFile } from "./view.ts";

export const PLANS_DIR = join(homedir(), ".pi", "plans");
export const MAX_PLANS = 20;
// Disk fallback recovery only for plans within 7 days (directory name contains creation ms timestamp);
// Expired plans not auto-restored to prevent cross-project/cross-week pollution
export const MAX_RESTORE_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Restore full tools when exiting restricted mode (the only correct way).
 * Do not use hardcoded tool name list to rebuild non-plan-mode tool set:
 * the list will inevitably lag behind extension registration
 * (admin, autopilot, memory, ctx, tmux and other tools are not in the static list),
 * using it will cause extension tools to be completely unavailable in this session
 * (session_start restores full set).
 * Exit read-only/restricted mode = restore full permissions.
 */
export function restoreAllTools(pi: ExtensionAPI): void {
  const all = pi.getAllTools().map((t) => t.name);
  pi.setActiveTools(all);
}

export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

export function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Get user message text (content may be string or TextContent[]) */
export function getUserText(message: AgentMessage): string {
  if (!("content" in message) || message.content === undefined) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b): b is TextContent => b.type === "text" && "text" in b)
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

export async function cleanupOldPlans(): Promise<void> {
  try {
    const entries = await readdir(PLANS_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(PLANS_DIR, e.name) }))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (dirs.length <= MAX_PLANS) return;

    for (const dir of dirs.slice(MAX_PLANS)) {
      await import("node:fs/promises").then((fs) => fs.rm(dir.path, { recursive: true, force: true }));
    }
  } catch {
    // directory may not exist yet
  }
}

export type QAPair = { role: "user" | "assistant"; content: string };

/** Session restore plan mode switch decision: --plan startup flag takes priority, persisted enabled=false does not override explicit startup */
export function resolvePlanModeEnabled(
  planFlag: boolean | undefined,
  persistedEnabled: boolean | undefined,
  current: boolean,
): boolean {
  if (planFlag === true) return true;
  return persistedEnabled ?? current;
}

export function capQaMessages(qa: QAPair[], max = 20): QAPair[] {
  if (qa.length <= max) return qa;
  return qa.slice(-max);
}

export async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
): Promise<{ stdout: string; code: number }> {
  try {
    const result = (await pi.exec("bash", ["-c", command], { cwd })) as {
      stdout?: string;
      code?: number;
    };
    return { stdout: result?.stdout ?? "", code: result?.code ?? 0 };
  } catch {
    return { stdout: "", code: 1 };
  }
}

/** P1: Parse task state from latest plan.md in PLANS_DIR (disk recovery fallback). */
export async function restoreStateFromFile(): Promise<import("./state.ts").TaskState | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const dirs = (await readdir(PLANS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith("plan-"))
      .map((d) => ({ name: d.name, ts: d.name.replace("plan-", "") }))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    for (const d of dirs) {
      // Only restore recent plans; skip expired plans (prevent cross-project/cross-week pollution)
      const ts = Number(d.ts);
      if (!Number.isFinite(ts) || Date.now() - ts > MAX_RESTORE_AGE_MS) continue;
      const file = join(PLANS_DIR, d.name, "plan.md");
      const content = await readFile(file, "utf-8").catch(() => null);
      if (!content) continue;
      const restored = parsePlanFile(content);
      if (!restored || restored.tasks.length === 0) continue;
      // Only restore plans with incomplete tasks; fully completed plans are meaningless to restore
      const hasRemaining = restored.tasks.some(
        (t) => t.status !== "completed" && t.status !== "deleted",
      );
      if (!hasRemaining) continue;
      return restored;
    }
  } catch { /* No usable plan files */ }
  return null;
}

/** Dynamically scan available skills */
export function discoverSkills(): { name: string; desc: string }[] {
  const base = join(homedir(), ".pi", "agent", "skills");
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    const skills: { name: string; desc: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      try {
        const content = readFileSync(join(base, name, "SKILL.md"), "utf-8");
        const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
        const desc =
          fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
        skills.push({ name, desc });
      } catch {
        skills.push({ name, desc: "" });
      }
    }
    return skills;
  } catch {
    return [];
  }
}
