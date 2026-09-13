/**
 * 诊断模块 - 处理用量记录和统计
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, statSync, renameSync } from "node:fs";
import {
  formatUsageSummary,
  loadDiagLines,
  recordAutoCompact,
  recordUsageMissing,
  recordPrune,
  recordThinkingMeter,
  recordToolCall,
  recordToolCallEvent,
  recordToolEnable,
  recordToolUsage,
  recordUsage,
  pruneToolEvents,
  recomputeToolUsage,
  type UsageRecord,
} from "../../lib/usage-diag.ts";

/** 诊断日志文件路径 */
const DIAG_FILE = join(homedir(), ".pi", "logs", "warm-diag.jsonl");

/** 诊断日志写入 */
export const diag = (reason: string, extra?: unknown) => {
  try {
    const st = statSync(DIAG_FILE);
    if (st.size > 2 * 1024 * 1024) renameSync(DIAG_FILE, `${DIAG_FILE}.old`);
  } catch {}
  try {
    appendFileSync(
      DIAG_FILE,
      JSON.stringify({ t: Date.now(), reason, extra: extra === undefined ? null : extra }) + "\n",
    );
  } catch {}
};

// 导出所有诊断函数
export {
  formatUsageSummary,
  loadDiagLines,
  recordAutoCompact,
  recordUsageMissing,
  recordPrune,
  recordThinkingMeter,
  recordToolCall,
  recordToolCallEvent,
  recordToolEnable,
  recordToolUsage,
  recordUsage,
  pruneToolEvents,
  recomputeToolUsage,
};
export type { UsageRecord };
