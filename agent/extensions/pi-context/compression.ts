/**
 * 压缩模块 - 处理上下文压缩和快照
 */

import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 压缩快照配置
export const SNAPSHOT_DIR = join(homedir(), ".pi", "logs", "compact-snapshots");
export const SNAPSHOT_MAX_FILES = 8;
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// JSON 压缩配置
export const MAX_JSON_PARSE_BYTES = 2 * 1024 * 1024;
export const JSON_MIN_ITEMS = 2;
export const MARK_BUDGET = 64;

/** 计算 JSON 对象的字节大小 */
export function jsonBytes(data: unknown): number {
  const s = JSON.stringify(data);
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

/** 二分收缩一层：数组保前一半元素；对象保前一半键 */
export function shrinkHalf(data: unknown): unknown {
  if (Array.isArray(data)) {
    if (data.length <= JSON_MIN_ITEMS) return data;
    return data.slice(0, Math.ceil(data.length / 2));
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.length <= JSON_MIN_ITEMS) return data;
    const half = Math.ceil(keys.length / 2);
    const out: Record<string, unknown> = {};
    for (const k of keys.slice(0, half)) out[k] = (data as Record<string, unknown>)[k];
    return out;
  }
  return data;
}

/**
 * JSON 结构性压缩：合法 JSON 且超限时二分收缩到预算内
 */
export function compactJson(
  text: string,
  cap: number,
): { text: string; omittedBytes: number } | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_PARSE_BYTES) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (jsonBytes(data) <= cap) return undefined;
  const budget = Math.max(1, cap - MARK_BUDGET);
  let current = data;
  for (let i = 0; i < 32; i++) {
    const shrunk = shrinkHalf(current);
    if (shrunk === current) break;
    current = shrunk;
    if (jsonBytes(current) <= budget) break;
  }
  const outBytes = jsonBytes(current);
  if (outBytes > budget) return undefined;
  const omittedBytes = Buffer.byteLength(text, "utf8") - outBytes;
  if (omittedBytes <= 0) return undefined;
  return {
    text: `${JSON.stringify(current)}\n\n[...truncated ${omittedBytes} bytes]`,
    omittedBytes,
  };
}

/** 压缩前保存快照 */
export function snapshotBeforeCompact(
  lastContextMessages: unknown[] | null,
  contextTokens: number,
  threshold: number,
  reason: "overflow" | "threshold" = "threshold",
): void {
  try {
    if (!lastContextMessages || lastContextMessages.length === 0) return;
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const ts = Date.now();
    const file = join(SNAPSHOT_DIR, `compact-${ts}.json`);
    const payload = {
      ts,
      contextTokens,
      threshold,
      reason,
      messages: lastContextMessages,
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    // 清理：超龄 + 超量
    const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.startsWith("compact-") && f.endsWith(".json"));
    const now = Date.now();
    const stale = new Set(
      files.filter((f) => {
        try {
          return now - statSync(join(SNAPSHOT_DIR, f)).mtimeMs > SNAPSHOT_MAX_AGE_MS;
        } catch {
          return false;
        }
      }),
    );
    const fresh = files.filter((f) => !stale.has(f)).sort().reverse();
    for (const f of fresh.slice(SNAPSHOT_MAX_FILES)) stale.add(f);
    for (const f of stale) {
      try {
        unlinkSync(join(SNAPSHOT_DIR, f));
      } catch {
        /* 并发清理竞态可忽略 */
      }
    }
  } catch (err) {
    console.error("pi-context: compact snapshot failed:", err);
  }
}
