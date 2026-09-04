/**
 * Usage-Diag — 每轮 LLM 用量记录与汇总（诊断用途）
 *
 * 记录每次 LLM 调用的 input/cacheRead/output/reasoning 到
 * ~/.pi/agent/.usage-diag.jsonl，/usage-diag 命令展示会话用量汇总。
 * 目标：量化每轮请求发送量（平台统计的核心），定位 token 消耗大头。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
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

/** 审计 M6 探针（2026-08-25）：provider 某轮未回传可用 usage 的事实记录 */
export interface UsageMissingEvent {
  type: "usage-missing";
  ts: number;
}

export type DiagLine = UsageRecord | AutoCompactEvent | PruneEvent | UsageMissingEvent;

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

// 审计 M6 探针（2026-08-25）：provider 缺 usage 时 turn_end 静默 return，扩展层阈值
// 压缩/压力提示/thinking 自适应全部跳过却无观测痕迹。此探针记录触发事实，
// 用于确认「依赖流式 usage 必存在」假设（上游 #8328 同类）的真实触发面。
let lastUsageMissingLog = 0;
const USAGE_MISSING_THROTTLE_MS = 10 * 60 * 1000;
export function recordUsageMissing(): void {
  const now = Date.now();
  if (now - lastUsageMissingLog < USAGE_MISSING_THROTTLE_MS) return;
  lastUsageMissingLog = now;
  try {
    const event: UsageMissingEvent = { type: "usage-missing", ts: now };
    appendFileSync(getDiagFile(), JSON.stringify(event) + "\n");
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

// ── thinking 思考量记账（2026-08-21，task #14 量化思考量）──
// provider（opencode-go）不返回 reasoning，量化思考量须从消息层 assistant thinking 块统计。
// pi-context context hook 每轮统计上下文内的 thinking token 总量，写一条 thinking-meter。
// 供 usage-stats --thinking 按会话聚合，对照档位（max→high）思考量变化。
// 仅数据文件、不进注入路径（缓存友好）；失败静默。
export interface ThinkingMeterEvent {
  type: "thinking-meter";
  ts: number;
  tokens: number;
}
export function recordThinkingMeter(tokens: number): void {
  try {
    const event: ThinkingMeterEvent = { type: "thinking-meter", ts: Date.now(), tokens };
    appendFileSync(getDiagFile(), JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

// ── thinking 档位切换记账（2026-08-21，task #25 档位自适应）──
// 每次档位切换强制落一条 level-change（来自/去/原因/压力），供 usage-stats --levels 审计。
// 切换后思考变化由 thinking-meter 持续记账天然关联（切点前后对照）。零注入、缓存友好。
export interface LevelChangeEvent {
  type: "level-change";
  ts: number;
  from: string;
  to: string;
  reason: string;
  pressure: string;
  /** 2026-08-21 混合方案：auto=规则自动切档 / model=模型提议经规则审批 */
  source?: "auto" | "model";
}
export function recordLevelChange(e: Omit<LevelChangeEvent, "type" | "ts">): void {
  try {
    const event: LevelChangeEvent = { type: "level-change", ts: Date.now(), ...e };
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

// ── 工具调用结构化记录（证据链辅助，2026-09-04）──
// 记录每次工具调用的完整元数据（名称、参数摘要、结果状态、耗时）到
// agent/stats/tool-events.jsonl，供 pi-memory 证据链关联与 usage-stats 工具级耗时分析。
// 与 ToolUseEvent（token 统计）互补：ToolUseEvent 记 token 量，此结构记调用语义。
export interface ToolCallRecordEvent {
  type: "tool-call";
  ts: number;
  tool: string;
  /** 参数 JSON 截断至 maxArgLen（防超大 bash 命令/write 内容撑爆台账） */
  args: string;
  /** 结果摘要截断至 maxOutputLen */
  result: string;
  /** 成功/失败 */
  ok: boolean;
  /** 调用耗时 ms */
  durationMs: number;
}

const MAX_TOOL_ARGS_LEN = 200;
const MAX_TOOL_RESULT_LEN = 300;

export function recordToolCallEvent(ev: {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  ok: boolean;
  durationMs: number;
}): void {
  try {
    const argsStr = JSON.stringify(ev.args ?? {}).slice(0, MAX_TOOL_ARGS_LEN);
    const resultStr = (ev.result ?? "").slice(0, MAX_TOOL_RESULT_LEN);
    const record: ToolCallRecordEvent = {
      type: "tool-call",
      ts: Date.now(),
      tool: ev.tool,
      args: argsStr,
      result: resultStr,
      ok: ev.ok,
      durationMs: ev.durationMs,
    };
    appendFileSync(getToolEventsFile(), JSON.stringify(record) + "\n");
  } catch {
    // 记录失败静默
  }
}

/** 读取工具调用记录（供 pi-memory 证据链与 usage-stats） */
export function loadToolCallRecords(max = 5000): ToolCallRecordEvent[] {
  try {
    const lines = readFileSync(getToolEventsFile(), "utf-8").trim().split("\n").filter(Boolean);
    const out: ToolCallRecordEvent[] = [];
    for (const line of lines.slice(-max)) {
      try {
        const e = JSON.parse(line);
        if (e && e.type === "tool-call") out.push(e);
      } catch { /* 损坏行跳过 */ }
    }
    return out;
  } catch {
    return [];
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
  firstTs: number
  lastTs: number
  byDevice: Record<string, { calls: number; input: number; lastTs: number }>
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
    const cur: ToolUsage = all[toolName] ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: Date.now(), lastTs: Date.now(), byDevice: {} }
    cur.calls += 1
    cur.input += usage.input ?? 0
    cur.cacheRead += usage.cacheRead ?? 0
    cur.cacheWrite += usage.cacheWrite ?? 0
    all[toolName] = cur
    const f = getToolUsageFile()
    mkdirSync(dirname(f), { recursive: true })
    const tmp = f + ".tmp." + process.pid
    writeFileSync(tmp, JSON.stringify(all), "utf8")
    renameSync(tmp, f)
  } catch {
    /* 记录失败静默 */
  }
}

// ── 工具调用事件日志（2026-08-24 重构：跨设备合并 + 30 天保留）──
// 旧 recordToolUsage 依赖 tool_result 的 per-call usage 回传，provider 缺失时
// （deepseek-flash 实证）导致 tool-usage.json 长期为空。改为无条件 append 事件日志：
//   · 每设备独立文件 memory/stats/tool-use-<device>.jsonl（Git 按文件合并，无冲突）
//   · eid = device:pid:seq 全局唯一 → 跨设备归并零歧义
//   · 每条带 ts/iso 时间戳；outputTokens 由调用方用 estimateTokens 兜底（usage 缺失也有量）
//   · append-only、O_APPEND 原子追加，崩溃/重启不丢
// 事件日志入库共享（memory/stats/，git pull 即合并）；聚合 tool-usage.json 仍本地重算（gitignored）。
export interface ToolUseEvent {
  type: "tool-use";
  eid: string;
  device: string;
  ts: number;
  iso: string;
  tool: string;
  outputTokens: number;
  input?: number;
  cacheRead?: number;
}

export const TOOL_RETENTION_DAYS = 30;
const TOOL_EVENTS_DIR_DEFAULT = join(homedir(), ".pi", "memory", "stats");

/** 设备标识：默认 hostname，可被 PI_DEVICE_ID 覆盖（避免不同设备 hostname 重名冲突） */
export function getDeviceId(): string {
  return process.env.PI_DEVICE_ID || hostname() || "host";
}
export function getToolEventsDir(): string {
  return process.env.PI_TOOL_EVENTS_DIR || TOOL_EVENTS_DIR_DEFAULT;
}
export function toolUseFile(device = getDeviceId()): string {
  return join(getToolEventsDir(), `tool-use-${device.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
}

let toolCallSeq = 0;
export function recordToolCall(ev: {
  tool: string;
  outputTokens: number;
  input?: number;
  cacheRead?: number;
}): void {
  try {
    const device = getDeviceId();
    toolCallSeq += 1;
    const ts = Date.now();
    const record: ToolUseEvent = {
      type: "tool-use",
      eid: `${device}:${process.pid}:${toolCallSeq}`,
      device,
      ts,
      iso: new Date(ts).toISOString(),
      tool: ev.tool,
      outputTokens: ev.outputTokens,
      ...(ev.input !== undefined ? { input: ev.input } : {}),
      ...(ev.cacheRead !== undefined ? { cacheRead: ev.cacheRead } : {}),
    };
    const f = toolUseFile(device);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // 记录失败静默
  }
}

/** 读取全部设备（或仅本机）maxDays 窗口内的工具调用事件，按 ts 升序。 */
export function loadToolUseEvents(allDevices = true, maxDays = TOOL_RETENTION_DAYS): ToolUseEvent[] {
  const dir = getToolEventsDir();
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const out: ToolUseEvent[] = [];
  try {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("tool-use-") || !name.endsWith(".jsonl")) continue;
      if (!allDevices && !name.includes(getDeviceId().replace(/[^A-Za-z0-9._-]/g, "_"))) continue;
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as ToolUseEvent;
          if (e && e.type === "tool-use" && e.ts >= cutoff) out.push(e);
        } catch {
          /* 损坏行跳过 */
        }
      }
    }
    out.sort((a, b) => a.ts - b.ts);
  } catch {
    /* 静默 */
  }
  return out;
}

/** 清理指定设备事件中超过 maxDays 天的记录，返回删除条数（默认只动本机文件，避免误删他人）。 */
export function pruneToolEvents(maxDays = TOOL_RETENTION_DAYS, device = getDeviceId()): number {
  const f = toolUseFile(device);
  try {
    if (!existsSync(f)) return 0;
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    const kept = lines.filter((l) => {
      try {
        return (JSON.parse(l) as ToolUseEvent).ts >= cutoff;
      } catch {
        return true;
      }
    });
    const removed = lines.length - kept.length;
    if (removed > 0) {
      const tmp = f + ".tmp." + process.pid;
      writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
      renameSync(tmp, f);
    }
    return removed;
  } catch {
    return 0;
  }
}

/** 从事件日志按 maxDays 窗口重算聚合，写回 tool-usage.json（含每设备分桶与首末时间）。 */
export function recomputeToolUsage(maxDays = TOOL_RETENTION_DAYS): Record<string, ToolUsage> {
  const events = loadToolUseEvents(true, maxDays);
  const acc = new Map<string, ToolUsage>();
  const seen = new Set<string>();
  for (const e of events) {
    // eid 去重（防 pull 竞态/重复行导致重复计数）
    if (seen.has(e.eid)) continue;
    seen.add(e.eid);
    let cur = acc.get(e.tool);
    if (!cur) {
      cur = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, firstTs: e.ts, lastTs: e.ts, byDevice: {} };
      acc.set(e.tool, cur);
    }
    cur.calls += 1;
    cur.input += e.input ?? 0;
    cur.cacheRead += e.cacheRead ?? 0;
    cur.firstTs = Math.min(cur.firstTs, e.ts);
    cur.lastTs = Math.max(cur.lastTs, e.ts);
    const d = cur.byDevice[e.device] ?? { calls: 0, input: 0, lastTs: e.ts };
    d.calls += 1;
    d.input += e.input ?? 0;
    d.lastTs = Math.max(d.lastTs, e.ts);
    cur.byDevice[e.device] = d;
  }
  const all = Object.fromEntries(acc);
  try {
    const f = getToolUsageFile();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, f);
  } catch {
    /* 静默 */
  }
  return all;
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

  const pruneEvents = lines.filter(
    (l) => "type" in l && (l.type === "prune" || l.type === "prune-think"),
  ) as PruneEvent[];
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
