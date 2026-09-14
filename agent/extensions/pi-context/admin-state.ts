import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADMIN_STATE_FILE =
  process.env.PI_CONTEXT_ADMIN_STATE || join(homedir(), ".pi", "agent", ".pi-admin-state.json");

export function readAdminStateAction(): string {
  try {
    const raw = readFileSync(ADMIN_STATE_FILE, "utf-8");
    const s = JSON.parse(raw) as { action?: string };
    return typeof s.action === "string" ? s.action : "none";
  } catch {
    return "none";
  }
}
