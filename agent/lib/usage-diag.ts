/**
 * Usage-Diag — 每轮 LLM 用量记录与汇总（诊断用途）
 *
 * 记录每次 LLM 调用的 input/cacheRead/output/reasoning 到
 * ~/.pi/agent/.usage-diag.jsonl，/usage-diag 命令展示会话用量汇总。
 * 目标：量化每轮请求发送量（平台统计的核心），定位 token 消耗大头。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UsageRecord {
  ts: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  contextTokens: number;
  compacted: boolean;
}

export interface AutoCompactEvent {
  type: "auto-compact";
  ts: number;
  contextTokens: number;
  threshold: number;
}

export interface PruneEvent {
  type: "prune";
  ts: number;
  prunedTokens: number;
  prunedChars: number;
  prunedCount: number;
}

export type DiagLine = UsageRecord | AutoCompactEvent | PruneEvent;

const DIAG_FILE = join(homedir(), ".pi", "agent", ".usage-diag.jsonl");
const MAX_LINES = 20_000;

export function getDiagFile(): string {
  return process.env.PI_USAGE_DIAG_FILE || DIAG_FILE;
}

export function recordUsage(record: UsageRecord): void {
  try {
    appendFileSync(getDiagFile(), JSON.stringify(record) + "\n");
  } catch {
    // 诊断记录失败不阻塞会话
  }
}

export function recordAutoCompact(contextTokens: number, threshold: number): void {
  try {
    const event: AutoCompactEvent = { type: "auto-compact", ts: Date.now(), contextTokens, threshold };
    appendFileSync(getDiagFile(), JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

export function recordPrune(prunedTokens: number, prunedChars: number, prunedCount: number): void {
  try {
    const event: PruneEvent = { type: "prune", ts: Date.now(), prunedTokens, prunedChars, prunedCount };
    appendFileSync(getDiagFile(), JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

export function loadDiagLines(max = 5000): DiagLine[] {
  try {
    if (!existsSync(getDiagFile())) return [];
    const lines = readFileSync(getDiagFile(), "utf8").split("\n").filter(Boolean);
    const out: DiagLine[] = [];
    for (const line of lines.slice(-max)) {
      try {
        const parsed = JSON.parse(line) as DiagLine;
        if (parsed && typeof parsed === "object") out.push(parsed);
      } catch {
        // 损坏行跳过
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface UsageSummary {
  requests: number;
  inputTotal: number;
  inputAvg: number;
  inputMax: number;
  cacheReadTotal: number;
  cacheHitRatio: number;
  outputTotal: number;
  reasoningTotal: number;
  compactEvents: number;
  recentTrend: number[];
}

export function summarizeRecords(records: UsageRecord[]): UsageSummary | null {
  if (records.length === 0) return null;
  const inputTotal = records.reduce((s, r) => s + r.input, 0);
  const cacheReadTotal = records.reduce((s, r) => s + r.cacheRead, 0);
  return {
    requests: records.length,
    inputTotal,
    inputAvg: Math.round(inputTotal / records.length),
    inputMax: Math.max(...records.map((r) => r.input)),
    cacheReadTotal,
    cacheHitRatio:
      inputTotal + cacheReadTotal > 0
        ? Math.round((cacheReadTotal / (inputTotal + cacheReadTotal)) * 100)
        : 0,
    outputTotal: records.reduce((s, r) => s + r.output, 0),
    reasoningTotal: records.reduce((s, r) => s + r.reasoning, 0),
    compactEvents: records.filter((r) => r.compacted).length,
    recentTrend: records.slice(-20).map((r) => r.contextTokens),
  };
}

export function formatUsageSummary(lines: DiagLine[]): string {
  const records = lines.filter(
    (l): l is UsageRecord => !("type" in l),
  ) as UsageRecord[];
  const summary = summarizeRecords(records);
  if (!summary) return "暂无用量记录（/usage-diag 需要先运行过至少一轮对话）。";

  const fmt = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
  const trend =
    summary.recentTrend.length > 0
      ? summary.recentTrend.map((n, i) => (i > 0 && i % 4 === 3 ? `${fmt(n)}\n  ` : `${fmt(n)} → `)).join("")
      : "-";

  const compactEvents = lines.filter((l) => "type" in l && l.type === "auto-compact");
  const compactLines =
    compactEvents.length > 0
      ? `  自动压缩触发: ${compactEvents.length} 次（最近: ${fmt(
          (compactEvents[compactEvents.length - 1] as AutoCompactEvent).contextTokens,
        )} @ 阈值 ${fmt((compactEvents[compactEvents.length - 1] as AutoCompactEvent).threshold)}）`
      : "  自动压缩触发: 0 次";

  const pruneEvents = lines.filter((l) => "type" in l && l.type === "prune") as PruneEvent[];
  const prunedTotal = pruneEvents.reduce((s, e) => s + e.prunedTokens, 0);
  const pruneLine =
    pruneEvents.length > 0
      ? `  分层擦除: ${pruneEvents.length} 次 · 累计回收 ${fmt(prunedTotal)} token · 最近 ${fmt(
          pruneEvents[pruneEvents.length - 1].prunedTokens,
        )}`
      : "  分层擦除: 0 次（上下文未超过保护带）";

  return [
    "=== 会话用量诊断 ===",
    `请求数: ${summary.requests}`,
    `输入(未命中): 合计 ${fmt(summary.inputTotal)} · 平均 ${fmt(summary.inputAvg)}/轮 · 峰值 ${fmt(summary.inputMax)}`,
    `缓存命中: ${fmt(summary.cacheReadTotal)} (${summary.cacheHitRatio}%)`,
    `输出: ${fmt(summary.outputTotal)}（其中 reasoning ${fmt(summary.reasoningTotal)}）`,
    compactLines,
    pruneLine,
    `最近 ${Math.min(20, summary.recentTrend.length)} 轮总输入(contextTokens):`,
    `  ${trend.trim()}`,
    "注: 平台统计量 = 输入未命中 + 缓存命中 + 输出；缓存命中按低价计费。",
  ].join("\n");
}
