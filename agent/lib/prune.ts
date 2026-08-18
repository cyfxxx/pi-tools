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

import { estimateTokens } from "./context-budget.ts";

// 保护带：从后往前累计保留的 token 预算（opencode PRUNE_PROTECT = 40_000）
// 2026-08-15 审计调至 80_000：事后擦除必然破坏 DeepSeek 前缀缓存（擦除轮从擦除点
// 全量重发）。保护带越大擦除触发越少，长会话中省下的重发成本远大于多留的上下文。
export const PRUNE_PROTECT_TOKENS = 80_000;
// 最低回收阈值：预计回收低于此值不应用（opencode PRUNE_MINIMUM = 20_000）
// 2026-08-15 审计调至 50_000：回收小于此值不值得承担一次缓存断裂（重发成本）。
export const PRUNE_MINIMUM_TOKENS = 50_000;
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
export function pruneMessageText(m: PruneMessage, chars: number): unknown {
  if (!Array.isArray(m.content)) return m.content;
  return (m.content as { type?: string; text?: string }[]).map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: PRUNE_MARKER(chars) };
    }
    // 非 text 块（图片等）同样擦除：替换为占位文本块，避免视觉数据持续占用上下文
    return { type: "text", text: PRUNE_MARKER(chars) };
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

/**
 * Thinking 保留预算：从后往前累计 assistant 消息的 thinking token，
 * 预算耗尽处及更早的 thinking 块全部删除（保留消息其余内容）。
 * 确定性：判定只依赖消息内容，内容不变结果不变 → 缓存前缀稳定。
 * 默认预算与 pi-context 的 KEEP_THINKING_TOKENS 一致。
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
  const next = input.map((m, i) => {
    if (i > cutoff || m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const filtered = (m.content as { type?: string; thinking?: string }[]).filter((b) => {
      if (b && b.type === "thinking") {
        removedChars += typeof b.thinking === "string" ? b.thinking.length : 0;
        return false;
      }
      return true;
    });
    return { ...m, content: filtered };
  });

  return {
    messages: next,
    modified: true,
    prunedCount: 1,
    prunedTokens: Math.ceil(removedChars / 4),
    prunedChars: removedChars,
  };
}
