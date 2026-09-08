/**
 * 任务完成即时记录（task #26，2026-08-21）
 *
 * "每次任务完成后"的零 LLM 即时层：agent_settled 时确定性写入一条结构化任务记录
 * （本轮用户请求摘要/用量/工具数/是否压缩/是否档位切换），与缓存命中、切档、
 * 思考量等 usage-diag 事件互为对照。真正"模型总结经验"由批量层
 * scripts/task-summarizer.mjs（spawn pi 后台，读本文件聚合后调 memory_store 入库）。
 *
 * 仅数据文件、不进注入面（缓存友好）；失败静默。
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TaskRecord {
  type: "task";
  ts: number;
  /** 本轮最后一条用户请求摘要（前 200 字，供总结层识别任务主题） */
  userRequest: string;
  /** 本轮请求总 token（input+cacheRead） */
  contextTokens: number;
  cacheHit: number;
  output: number;
  /** 本轮工具调用次数 */
  tools: number;
  /** 本轮是否触发自动压缩 */
  compacted: boolean;
  /** 本轮是否发生 thinking 档位切换 */
  levelChanged: boolean;
  /** 会话内累计 user 消息数（单调，供总结层滤空话/阈值判断） */
  userSeq: number;
}

export const TASK_RECORD_FILE = join(homedir(), ".pi", "logs", "task-records.jsonl");

export function getTaskRecordFile(): string {
  return process.env.PI_TASK_RECORD_FILE || TASK_RECORD_FILE;
}

export function recordTaskRecord(e: Omit<TaskRecord, "type" | "ts">): void {
  // 后台总结/隔离任务（task-summarizer spawn 的 pi）不写任务记录，
  // 避免总结轮被再次总结形成递归积累。
  if (process.env.PI_DISABLE_TASK_RECORD === "1") return;
  try {
    const rec: TaskRecord = { type: "task", ts: Date.now(), ...e };
    appendFileSync(getTaskRecordFile(), JSON.stringify(rec) + "\n");
  } catch {
    // ignore
  }
}

export function loadTaskRecords(): TaskRecord[] {
  try {
    if (!existsSync(getTaskRecordFile())) return [];
    const recs: TaskRecord[] = [];
    for (const l of readFileSync(getTaskRecordFile(), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l);
        if (r && r.type === "task") recs.push(r as TaskRecord);
      } catch {
        // 跳过损坏行
      }
    }
    return recs;
  } catch {
    return [];
  }
}
