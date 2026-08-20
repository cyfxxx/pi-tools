/**
 * Usage-Diag — 每轮 LLM 用量记录与汇总（诊断用途）
 *
 * 记录每次 LLM 调用的 input/cacheRead/output/reasoning 到
 * ~/.pi/agent/.usage-diag.jsonl，/usage-diag 命令展示会话用量汇总。
 * 目标：量化每轮请求发送量（平台统计的核心），定位 token 消耗大头。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UsageRecord {
  ts: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  contextTokens: number;
}

export interface AutoCompactEvent {
  type: "auto-compact";
  ts: number;
  contextTokens: number;
  threshold: number;
}

export interface PruneEvent {
  type: "prune" | "prune-think";
  ts: number;
  prunedTokens: number;
  prunedChars: number;
  prunedCount: number;
}

export type DiagLine = UsageRecord | AutoCompactEvent | PruneEvent;

const DIAG_FILE = join(homedir(), ".pi", "agent", ".usage-diag.jsonl");
const MAX_LINES = 20_000;

// 写入节流：每 N 行检查一次行数，超上限截断重写（保留尾部）。appendFileSync 无限
// 追加时文件无界增长（审计实测 739KB/5K+ 行且 MAX_LINES 从未被引用）。
let linesSinceCheck = 0;
const CHECK_EVERY = 500;

export function getDiagFile(): string {
  return process.env.PI_USAGE_DIAG_FILE || DIAG_FILE;
}

function rotateIfNeeded(): void {
  linesSinceCheck++
  if (linesSinceCheck < CHECK_EVERY) return
  linesSinceCheck = 0
  try {
    const content = readFileSync(getDiagFile(), "utf-8")
    const trimmed = trimDiagContent(content)
    if (trimmed !== null) {
      const tmp = getDiagFile() + ".tmp." + process.pid
      writeFileSync(tmp, trimmed)
      renameSync(tmp, getDiagFile())
    }
  } catch {
    // 轮转失败不阻塞：下次检查再试
  }
}

/** 超上限时截断为尾部 MAX_LINES 行；未超限返回 null（纯函数便于测试） */
export function trimDiagContent(content: string, maxLines: number = MAX_LINES): string | null {
  const lines = content.split("\n").filter(Boolean)
  if (lines.length <= maxLines) return null
  return lines.slice(-maxLines).join("\n") + "\n"
}

export function recordUsage(record: UsageRecord): void {
  try {
    appendFileSync(getDiagFile(), JSON.stringify(record) + "\n");
    rotateIfNeeded();
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

export function recordPrune(
  prunedTokens: number,
  prunedChars: number,
  prunedCount: number,
  kind: "tool" | "thinking" = "tool",
): void {
  try {
    const event: PruneEvent = {
      type: kind === "thinking" ? "prune-think" : "prune",
      ts: Date.now(),
      prunedTokens,
      prunedChars,
      prunedCount,
    };
    appendFileSync(getDiagFile(), JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

// ── 工具启用事件台账（2026-08-19）──
// enable_tool 是唯一改变运行时工具集的入口（pi-context 分层，改 setActiveTools）。
// 启用事件落到独立台账 agent/stats/tool-events.jsonl（非 usage-diag，避免污染用量统计），
// 供 usage-stats 在 A 类断裂（前缀全段重放）时按 ts 关联归因：有事件 → 工具 schema 变化；
// 无事件 → 排除工具侧，指向 compaction/provider。仅数据文件、不进注入路径（缓存友好）。
export interface ToolEnableEvent {
  type: "tool-enable";
  ts: number;
  group: string;
  via: "enable_tool" | "cmd";
}

export const TOOL_EVENTS_FILE = join(homedir(), ".pi", "agent", "stats", "tool-events.jsonl");

export function getToolEventsFile(): string {
  return process.env.PI_TOOL_EVENTS_FILE || TOOL_EVENTS_FILE;
}

export function recordToolEnable(group: string, via: "enable_tool" | "cmd"): void {
  try {
    const ev: ToolEnableEvent = { type: "tool-enable", ts: Date.now(), group, via };
    appendFileSync(getToolEventsFile(), JSON.stringify(ev) + "\n");
  } catch {
    // ignore（台账失败不影响工具启用功能）
  }
}

/** 读取工具启用事件台账（供 usage-stats 等诊断工具） */
export function loadToolEnableEvents(): ToolEnableEvent[] {
  try {
    return readFileSync(getToolEventsFile(), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l) as ToolEnableEvent } catch { return null }
      })
      .filter((e): e is ToolEnableEvent => e !== null && e.type === "tool-enable");
  } catch {
    return [];
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

// ── 工具用量账单（2026-08-20，2.5 阶段；数据源 tool_result hook 的 per-call usage）──
// 按工具名累加调用次数与 input/cacheRead/cacheWrite，持久化 stats/tool-usage.json。
// MK：只写 stats 数据文件，不进注入面/上下文（缓存友好）；失败静默。
export interface ToolUsage {
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
}
export const TOOL_USAGE_FILE = join(homedir(), ".pi", "agent", "stats", "tool-usage.json")
export function getToolUsageFile(): string {
  return process.env.PI_TOOL_USAGE_FILE || TOOL_USAGE_FILE
}
export function loadToolUsage(): Record<string, ToolUsage> {
  try {
    const f = getToolUsageFile()
    if (!existsSync(f)) return {}
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, ToolUsage>
  } catch {
    return {}
  }
}
export function recordToolUsage(
  toolName: string,
  usage: { input?: number; cacheRead?: number; cacheWrite?: number },
): void {
  try {
    const all = loadToolUsage()
    const cur: ToolUsage = all[toolName] ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
    cur.calls += 1
    cur.input += usage.input ?? 0
    cur.cacheRead += usage.cacheRead ?? 0
    cur.cacheWrite += usage.cacheWrite ?? 0
    all[toolName] = cur
    const f = getToolUsageFile()
    mkdirSync(dirname(f), { recursive: true })
    const tmp = f + ".tmp"
    writeFileSync(tmp, JSON.stringify(all), "utf8")
    renameSync(tmp, f)
  } catch {
    /* 记录失败静默 */
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
