/**
 * Auto-Compact — 按模型窗口比例的自动压缩阈值策略（含防抖）
 *
 * 背景：pi 内置 shouldCompact 阈值 = contextWindow - settings.reserveTokens，
 * 对 1M 窗口模型（deepseek-v4-flash）阈值高达 96.7 万 token，自动压缩形同虚设，
 * 会话每轮全量重发持续膨胀，平台 token 统计量远超及时压缩的工具。
 * 这里按窗口比例给出合理阈值，由扩展在 agent_end 触发 ctx.compact()。
 *
 * 阈值选择依据（2026-08 长任务实测：缓存命中率 86%，deepseek 缓存命中价格
 * 为输入的 1/50；2026-08-17 对照 DeepSeek Harness（dsh）compaction-basic 策略：
 * thresholdRatio 0.8 + 溢出恢复兜底，实测晚压缩更优——本实现同步对齐）：
 *  - 每轮全量重发的 cacheRead 成本可忽略 → 晚压缩更优（模型视野更大、压缩次数更少）
 *  - 窗口 > 256K（如 deepseek-v4 系列 1M）：80% 触发（dsh 同值；内核压缩兜底
 *    阈值 = 窗口 - reserveTokens（32K），0.8 给兜底留 20% 余量）
 *  - 窗口 ≤ 256K（如 local-llama 131K）：85% 触发，接近原生压缩行为
 */

export type CompactReason = "under-threshold" | "over-threshold" | "cooldown" | "no-window";

export interface CompactDecision {
  shouldCompact: boolean;
  threshold: number;
  contextTokens: number;
  reason: CompactReason;
}

// 窗口 > 256K（如 deepseek-v4 系列 1M）：80% 触发（对齐 dsh thresholdRatio 0.8）
// 窗口 ≤ 256K（如 local-llama 131K）：85% 触发，接近原生压缩行为
export const LARGE_WINDOW_SIZE = 256_000;
export const LARGE_WINDOW_RATIO = 0.8;
export const SMALL_WINDOW_RATIO = 0.85;
export const DEFAULT_COOLDOWN_MS = 180_000;

export interface CompactThresholdOpts {
  /** 大窗口分界（默认 256K） */
  largeWindowSize?: number
  /** 大窗口压缩比例（默认 0.8，对齐 dsh thresholdRatio） */
  largeRatio?: number
  /** 小窗口压缩比例（默认 0.85） */
  smallRatio?: number
  /** 绝对 token 阈值（>0 时优先于窗口比例；用户策略 2026-08-24：上下文长度 >256K 才考虑压缩） */
  absoluteTokens?: number
}

export function computeCompactThreshold(
  contextWindow: number,
  opts: CompactThresholdOpts = {},
): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  // 绝对阈值优先（如 256K 固定值），不随窗口比例浮动
  if (typeof opts.absoluteTokens === "number" && opts.absoluteTokens > 0) {
    return Math.floor(opts.absoluteTokens);
  }
  const lws = opts.largeWindowSize ?? LARGE_WINDOW_SIZE;
  const lr = opts.largeRatio ?? LARGE_WINDOW_RATIO;
  const sr = opts.smallRatio ?? SMALL_WINDOW_RATIO;
  const ratio = contextWindow > lws ? lr : sr;
  return Math.floor(contextWindow * ratio);
}

export interface CompactDecider {
  readonly cooldownMs: number;
  readonly lastCompactAt: number;
  decide(contextTokens: number, contextWindow: number, now?: number): CompactDecision;
  markCompact(now?: number): void;
}

/**
 * 有状态判定器：decide 只读判定；调用方真正触发压缩后调用 markCompact 记时，
 * cooldown 内不再重复触发（防止压缩循环）。
 */
export function makeCompactDecider(
  cooldownMs = DEFAULT_COOLDOWN_MS,
  opts: CompactThresholdOpts = {},
): CompactDecider {
  let lastCompactAt = 0;
  return {
    get cooldownMs() {
      return cooldownMs;
    },
    get lastCompactAt() {
      return lastCompactAt;
    },
    decide(contextTokens, contextWindow, now = Date.now()): CompactDecision {
      const threshold = computeCompactThreshold(contextWindow, opts);
      if (threshold === null) {
        return { shouldCompact: false, threshold: 0, contextTokens, reason: "no-window" };
      }
      if (contextTokens <= threshold) {
        return { shouldCompact: false, threshold, contextTokens, reason: "under-threshold" };
      }
      if (now - lastCompactAt < cooldownMs) {
        return { shouldCompact: false, threshold, contextTokens, reason: "cooldown" };
      }
      return { shouldCompact: true, threshold, contextTokens, reason: "over-threshold" };
    },
    markCompact(now = Date.now()): void {
      lastCompactAt = now;
    },
  };
}

/**
 * 压缩后自动继续门（借鉴 opencode compaction.autocontinue）
 *
 * 场景：本扩展触发 ctx.compact() 后（agent_end），压缩完成由 session_compact
 * 事件通知。此时应注入"继续指令"启动新一轮，让长任务不断裂。
 * 问题：ctx.compact() 触发的 session_compact reason 恒为 "manual"，无法与用户
 * 手动 /compact 区分。这里用一个门：本扩展触发压缩时 arm()，压缩失败时
 * disarm()；session_compact 回调里 shouldContinue() 返回 true 则自动继续并自动 disarm。
 * enabled=false 时直接拒绝（可做配置开关，当前默认开启）。
 */
export interface AutoContinueGate {
  readonly enabled: boolean;
  readonly armed: boolean;
  /** 本扩展触发压缩时调用（压缩开始前） */
  arm(): void;
  /** 压缩失败/异常时调用（放弃自动继续） */
  disarm(): void;
  /** session_compact 回调：若是本扩展触发的且开启 → disarm 并返回 true */
  shouldContinue(): boolean;
}

export function makeAutoContinueGate(enabled = true): AutoContinueGate {
  let armed = false;
  return {
    get enabled() {
      return enabled;
    },
    get armed() {
      return armed;
    },
    arm(): void {
      armed = enabled;
    },
    disarm(): void {
      armed = false;
    },
    shouldContinue(): boolean {
      if (!armed) return false;
      armed = false;
      return enabled;
    },
  };
}
