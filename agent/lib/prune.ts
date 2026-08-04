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
 * - 判定只依赖消息内容本身 → 每轮结果一致，缓存前缀稳定
 * - 新消息追加后擦除点单调后移、已擦除的不会恢复
 * - 零 LLM 成本，推迟 auto-compact 触发、减少摘要调用
 */

import { estimateTokens } from "./context-budget.ts";

// 保护带：从后往前累计保留的 token 预算（opencode PRUNE_PROTECT = 40_000）
export const PRUNE_PROTECT_TOKENS = 40_000;
// 最低回收阈值：预计回收低于此值不应用（opencode PRUNE_MINIMUM = 20_000）
export const PRUNE_MINIMUM_TOKENS = 20_000;
// 最近 N 个用户轮次豁免（opencode 跳过最近 2 轮）
export const KEEP_RECENT_TURNS = 2;
// 擦除后的占位文本
export const PRUNE_MARKER = (chars: number): string => `[pruned: ${chars} chars]`;

export interface PruneMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface PruneOptions {
  protectTokens?: number;
  minimumTokens?: number;
  keepRecentTurns?: number;
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

/** 将消息 content 中的 text block 全部替换为占位文本；返回替换后的 content */
export function pruneMessageText(m: PruneMessage, chars: number): unknown {
  if (!Array.isArray(m.content)) return m.content;
  return (m.content as { type?: string; text?: string }[]).map((block) => {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      return { ...block, text: PRUNE_MARKER(chars) };
    }
    return block;
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

  // 每条 toolResult 消息的估算 token
  const sizes: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (m.role !== "toolResult") continue;
    sizes[i] = estimateTokens(messageText(m));
  }

  // 从后往前累计保留预算：保护带内（最近轮次）无条件保留，绝不消耗预算；
  // 保护带外更早的 toolResult 按预算保留，预算耗尽后加入擦除候选
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
    const chars = messageText(m).length;
    return { ...m, content: pruneMessageText(m, chars) };
  });

  return { messages: next, modified: true, prunedCount: toPrune.length, prunedTokens, prunedChars };
}
