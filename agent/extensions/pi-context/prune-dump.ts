import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 擦除溯源 refs（借鉴 TencentDB-Agent-Memory 的 refs 卸载 + Reclaimer 清理）──
export const PRUNE_REFS_DIR = join(homedir(), ".pi", "logs", "prune-refs");
export const PRUNE_REFS_RETENTION_DAYS = 14;

type PruneDumpCtx = { sessionManager?: { getSessionId?: () => string | null | undefined } };

/** 构造擦除落盘回调 */
export function buildPruneDumpRef(ctx: PruneDumpCtx | undefined) {
  let sessionId = "adhoc";
  try {
    sessionId = String(ctx?.sessionManager?.getSessionId?.() || "adhoc");
  } catch {
    // 取不到会话身份时退化为共享文件
  }
  const file = join(PRUNE_REFS_DIR, `${sessionId}.md`);
  let dirReady = false;
  let seq = 0;
  return (text: string, meta: { index: number; chars: number }): string | null => {
    if (text.includes("[pruned:")) return null;
    if (!dirReady) {
      mkdirSync(PRUNE_REFS_DIR, { recursive: true });
      dirReady = true;
    }
    seq++;
    appendFileSync(
      file,
      `\n## 擦除条目 e${seq} · ${new Date().toISOString()} · 消息#${meta.index} · ${meta.chars} 字符\n\n${text}\n`,
      "utf8",
    );
    return file;
  };
}
