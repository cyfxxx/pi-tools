/**
 * 兼容层 + 分层擦除：原输出预算/裁剪函数整合进 lib/context-budget.ts，此处
 * 保留 re-export 以便既有扩展 import 路径不变；同时新增"工具输出分层擦除"
 * （借鉴 opencode SessionCompaction.prune，见 lib/prune.ts 顶部注释）。
 */
export * from './context-budget.ts'

/**
 * Prune — 工具输出分层擦除（借鉴 opencode SessionCompaction.prune）
 *
 * 背景：pi-context 已有写入时截断（tool_result 事件 5KB），但截断后的输出
 * 仍随轮次逐条保留在上下文中，长会话里旧工具输出是上下文的主要消耗。
 * opencode 的做法：保留最近 2 轮 + 40K token 保护带内不动，更早的已完成
 * 工具输出在构建上下文时擦除（调用记录保留，仅删输出），回收 >20K 才执行。
 *
 * 本模块在 pi 的 context 事件阶段做同款"事后擦除"（确定性变换）：
 * - 判定只依赖消息内容本身 → 同一输入结果一致（但**擦除本身改变消息序列**：
 *   擦除轮发送的序列 ≠ 上一轮 → DeepSeek 前缀缓存从擦除点断裂、全量重发。
 *   2026-08-15 实测：每轮擦除触发轮新增 40-60K、长会话 250K+ 时重发 200K+；
 *   成本量化：日擦除断裂 ~4.7M tokens 浪费，高于 auto-compact 一次性成本。
 *   已通过提高保护带(80K)/最低回收(50K)降低触发频率；真正结构性解法是
 *   依赖 auto-compact（一次性断裂+摘要）而非每轮事后擦除）
 * - 新消息追加后擦除点单调后移、已擦除的不会恢复
 * - 零 LLM 成本，推迟 auto-compact 触发、减少摘要调用
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { estimateTokens } from "./context-budget.ts";

// 保护带：从后往前累计保留的 token 预算（opencode PRUNE_PROTECT = 40_000）
// 2026-08-15 审计调至 80_000：事后擦除必然破坏 DeepSeek 前缀缓存（擦除轮从擦除点
// 全量重发）。保护带越大擦除触发越少，长会话中省下的重发成本远大于多留的上下文。
// 2026-08-18 再调至 120_000：承载 1M 窗口（compact 阈值 40%=400K）下普通会话全程
// 不触发；对齐"append-only 不动老消息"缓存哲学（Reasonix/Orca 实测 99%+ 命中），
// 事后擦除仅作为极长会话的底线保障，清理职责让给 auto-compact（一次性断裂）。
export const PRUNE_PROTECT_TOKENS = 120_000;
// 最低回收阈值：预计回收低于此值不应用（opencode PRUNE_MINIMUM = 20_000）
// 2026-08-15 审计调至 50_000：回收小于此值不值得承担一次缓存断裂（重发成本）。
// 2026-08-18 再调至 80_000：与保护带同步提高，减少触发频率（每次擦除=一次缓存断裂）。
export const PRUNE_MINIMUM_TOKENS = 80_000;
// 最近 N 个用户轮次豁免（opencode 跳过最近 2 轮）
export const KEEP_RECENT_TURNS = 2;
// 擦除后的占位文本
export const PRUNE_MARKER = (chars: number): string => `[pruned: ${chars} chars]`;
// 已擦除消息的识别签名：二次扫描时跳过（保证 marker 稳定、不重复落盘）
export const PRUNE_SENTINEL = "[pruned:";
// 带溯源路径的占位文本（借鉴 TencentDB-Agent-Memory 的 refs 卸载思路：
// 擦除≠销毁，原文落盘 refs 文件，marker 内嵌路径可 grep/read 下钻找回）
export const PRUNE_MARKER_REF = (chars: number, ref: string): string =>
  `[pruned: ${chars} chars → ${ref}]`;

export interface PruneMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface PruneOptions {
  protectTokens?: number;
  minimumTokens?: number;
  keepRecentTurns?: number;
  /** 擦除时把原文落盘的回调；返回引用路径嵌入 marker（null/抛错 → 降级纯 chars marker） */
  dumpRef?: (text: string, meta: { index: number; chars: number }) => string | null;
}

export interface PruneResult {
  messages: PruneMessage[];
  /** 是否发生了修改 */
  modified: boolean;
  /** 擦除的消息数 */
  prunedCount: number;
  /** 回收的估算 token 数 */
  prunedTokens: number;
  /** 擦除的字符数 */
  prunedChars: number;
}

/** 从消息 content（blocks 数组）中提取全部文本并计算估算 token 数 */
export function messageText(m: PruneMessage): string {
  if (!Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const block of m.content as { type?: string; text?: string }[]) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** 非 text 块（图片/附件等）数量：无法按字符估算，参与擦除判定时按名义 token 计 */
export function nonTextBlockCount(m: PruneMessage): number {
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const block of m.content as { type?: string; text?: string }[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text" || typeof block.text !== "string") n++;
  }
  return n;
}

// 非 text 块名义 token（保守下限：read 返回的截图常见视觉 token 数百至上千）
export const NON_TEXT_BLOCK_TOKENS = 1000;

/** 将消息 content 中全部块替换为占位文本（text 块与非 text 块一律擦除）；返回替换后的 content */
export function pruneMessageText(m: PruneMessage, chars: number, marker?: string): unknown {
  const text = marker ?? PRUNE_MARKER(chars);
  if (!Array.isArray(m.content)) return m.content;
  return (m.content as { type?: string; text?: string }[]).map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text };
    }
    // 非 text 块（图片等）同样擦除：替换为占位文本块，避免视觉数据持续占用上下文
    return { type: "text", text };
  });
}

/**
 * 分层擦除：从后往前扫描，最近 keepRecentTurns 轮 + protectTokens 保护带内保留，
 * 保护带外更早的 toolResult 消息输出替换为占位；仅当预计回收 ≥ minimumTokens 才应用。
 * 返回新数组（无修改时原样返回，便于调用方判断）。
 */
export function pruneToolResults(
  input: PruneMessage[],
  opts: PruneOptions = {},
): PruneResult {
  const protectTokens = opts.protectTokens ?? PRUNE_PROTECT_TOKENS;
  const minimumTokens = opts.minimumTokens ?? PRUNE_MINIMUM_TOKENS;
  const keepRecentTurns = opts.keepRecentTurns ?? KEEP_RECENT_TURNS;

  const messages = input;
  const n = messages.length;
  if (n === 0) return { messages, modified: false, prunedCount: 0, prunedTokens: 0, prunedChars: 0 };

  // 轮次边界：从后往前数 user 消息，最近 keepRecentTurns 个用户轮整体豁免
  let userSeen = 0;
  let protectedStart = n; // 保护带的起始下标（含）
  for (let i = n - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    userSeen++;
    if (userSeen === keepRecentTurns) {
      protectedStart = i;
      break;
    }
  }

  // 每条 toolResult 消息的估算 token（含非 text 块名义 token）
  const sizes: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m.role !== "toolResult") continue;
    sizes[i] = estimateTokens(messageText(m)) + NON_TEXT_BLOCK_TOKENS * nonTextBlockCount(m);
  }

  // 从后往前累计保留预算：保护带内（最近轮次）无条件保留，绝不消耗预算；
  // 保护带外更早的 toolResult 按预算保留，预算耗尽后加入擦除候选。
  // 已擦除消息（含 sentinel）跳过：marker 已稳定，重选只会重写对象/重复落盘
  let budgetLeft = protectTokens;
  const toPrune: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    if (sizes[i] === 0) continue;
    if (i >= protectedStart) {
      continue; // 保护带内：无条件保留
    }
    if (budgetLeft > 0) {
      budgetLeft = Math.max(0, budgetLeft - sizes[i]);
      continue;
    }
    if (messageText(messages[i]).includes(PRUNE_SENTINEL)) continue; // 已擦除
    toPrune.push(i);
  }

  if (toPrune.length === 0) {
    return { messages, modified: false, prunedCount: 0, prunedTokens: 0, prunedChars: 0 };
  }

  let prunedTokens = 0;
  let prunedChars = 0;
  for (const idx of toPrune) {
    prunedTokens += sizes[idx];
    prunedChars += messageText(messages[idx]).length;
  }

  if (prunedTokens < minimumTokens) {
    return { messages, modified: false, prunedCount: 0, prunedTokens, prunedChars };
  }

  const next = messages.map((m, i) => {
    if (!toPrune.includes(i)) return m;
    const text = messageText(m);
    const chars = text.length;
    let marker: string | undefined;
    if (opts.dumpRef) {
      try {
        const ref = opts.dumpRef(text, { index: i, chars });
        if (ref) marker = PRUNE_MARKER_REF(chars, ref);
      } catch {
        // 落盘失败降级为纯 chars marker：擦除本身不受影响
      }
    }
    return { ...m, content: pruneMessageText(m, chars, marker) };
  });

  return { messages: next, modified: true, prunedCount: toPrune.length, prunedTokens, prunedChars };
}

// ── 擦除溯源 refs 清理（借鉴 TencentDB-Agent-Memory Reclaimer）──

export interface SweepRefsOptions {
  /** 文件保留天数（按 mtime）；<0 禁用按龄清理。默认 14 */
  retentionDays?: number;
  /** 目录总大小上限（字节），超限从最旧删起。默认 50MB */
  maxTotalBytes?: number;
}

export interface SweepRefsStats {
  scanned: number;
  deletedByAge: number;
  deletedBySize: number;
  freedBytes: number;
}

/**
 * 清理擦除溯源 refs 目录：过期文件删除 + 总量超限时从最旧删起。
 * 单文件失败不阻断整体；目录不存在视为空。异步、无副作用副作用面小。
 */
export async function sweepPruneRefs(dir: string, opts: SweepRefsOptions = {}): Promise<SweepRefsStats> {
  const retentionDays = opts.retentionDays ?? 14;
  const maxTotalBytes = opts.maxTotalBytes ?? 50 * 1024 * 1024;
  const stats: SweepRefsStats = { scanned: 0, deletedByAge: 0, deletedBySize: 0, freedBytes: 0 };
  let files: { path: string; mtime: number; size: number }[] = [];
  try {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) continue;
      files.push({ path: p, mtime: st.mtimeMs, size: st.size });
    }
  } catch {
    return stats;
  }
  stats.scanned = files.length;
  if (retentionDays >= 0) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const f of files) {
      if (f.mtime >= cutoff) continue;
      try {
        await unlink(f.path);
        stats.deletedByAge++;
        stats.freedBytes += f.size;
        f.size = 0;
      } catch {
        // 单文件失败忽略
      }
    }
  }
  let remaining = files.reduce((s, f) => s + f.size, 0);
  if (remaining > maxTotalBytes) {
    for (const f of [...files].sort((a, b) => a.mtime - b.mtime)) {
      if (remaining <= maxTotalBytes) break;
      if (f.size === 0) continue;
      try {
        await unlink(f.path);
        stats.deletedBySize++;
        stats.freedBytes += f.size;
        remaining -= f.size;
        f.size = 0;
      } catch {
        // 单文件失败忽略
      }
    }
  }
  return stats;
}

/**
 * Thinking 保留预算：从后往前累计 assistant 消息的 thinking token，
 * 预算耗尽处及更早的 thinking 块全部删除（保留消息其余内容）。
 * 确定性：判定只依赖消息内容，内容不变结果不变 → 缓存前缀稳定。
 * 2026-08-22 起 pi-context context 阶段已停用本函数（对齐 append-only，清理职责让给
 * auto-compact），仅保留作未来 compact 后可选兜底；DEFAULT_KEEP_THINKING_TOKENS 为其独立默认值。
 *
 * 2026-08-18 实测：16K 预算下 max 推理级别每 2-3 轮即超预算，剪枝触发率
 * 70%，且每次触发都修改早期消息序列 → 前缀缓存从删除点断裂全价重发
 * （3.8h 会话 27 次断裂、1.46M token 浪费 ≈ 9.2M/天）。预算提高至 64K：
 * 覆盖典型会话全部 thinking（实测 52K），剪枝休眠；仅超长深推理会话触发，
 * 触发间隔 = 64K/每轮 thinking ≈ 12-30 轮，断裂频率可控。
 */
export const DEFAULT_KEEP_THINKING_TOKENS = 64_000;

export function pruneThinkingBudget(input: PruneMessage[], budgetTokens = DEFAULT_KEEP_THINKING_TOKENS): PruneResult {
  const n = input.length;
  let thinkingBudget = budgetTokens;
  let cutoff = -1;
  for (let i = n - 1; i >= 0; i--) {
    const m = input[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const thinkingText = (m.content as { type?: string; thinking?: string }[])
      .filter((b) => b && b.type === "thinking" && typeof b.thinking === "string")
      .map((b) => b.thinking as string)
      .join("\n");
    const t = estimateTokens(thinkingText);
    if (t === 0) continue;
    if (thinkingBudget - t < 0) {
      cutoff = i;
      break;
    }
    thinkingBudget -= t;
  }
  if (cutoff < 0) {
    return { messages: input, modified: false, prunedCount: 0, prunedTokens: 0, prunedChars: 0 };
  }

  let removedChars = 0;
  let modifiedCount = 0; // 实际被修改的消息数（一次擦除通常跨多条消息，非恒 1）
  const next = input.map((m, i) => {
    if (i > cutoff || m.role !== "assistant" || !Array.isArray(m.content)) return m;
    let touched = false;
    const filtered = (m.content as { type?: string; thinking?: string }[]).filter((b) => {
      if (b && b.type === "thinking") {
        removedChars += typeof b.thinking === "string" ? b.thinking.length : 0;
        touched = true;
        return false;
      }
      return true;
    });
    if (touched) modifiedCount++;
    return { ...m, content: filtered };
  });

  return {
    messages: next,
    modified: true,
    prunedCount: modifiedCount, // 统计实际修改的消息数（审计修复：原硬编码 1 与跨消息擦除不符）
    prunedTokens: Math.ceil(removedChars / 4),
    prunedChars: removedChars,
  };
}
