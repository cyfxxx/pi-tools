/**
 * Auto-Compact — 按模型窗口比例的自动压缩阈值策略（含防抖）
 *
 * 背景：pi 内置 shouldCompact 阈值 = contextWindow - settings.reserveTokens，
 * 对 1M 窗口模型（deepseek-v4-flash）阈值高达 96.7 万 token，自动压缩形同虚设，
 * 会话每轮全量重发持续膨胀，平台 token 统计量远超及时压缩的工具。
 * 这里按窗口比例给出合理阈值，由扩展在 turn_end 触发 ctx.compact()。
 */

export type CompactReason = "over-threshold" | "cooldown" | "no-window";

export interface CompactDecision {
  shouldCompact: boolean;
  threshold: number;
  contextTokens: number;
  reason: CompactReason;
}

// 窗口 > 256K（如 deepseek-v4-flash 1M）：20% 触发，封顶每轮发送量
// 窗口 ≤ 256K（如 local-llama 131K）：85% 触发，接近原生压缩行为
export const LARGE_WINDOW_SIZE = 256_000;
export const LARGE_WINDOW_RATIO = 0.2;
export const SMALL_WINDOW_RATIO = 0.85;
export const DEFAULT_COOLDOWN_MS = 180_000;

export function computeCompactThreshold(contextWindow: number): number | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const ratio =
    contextWindow > LARGE_WINDOW_SIZE ? LARGE_WINDOW_RATIO : SMALL_WINDOW_RATIO;
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
export function makeCompactDecider(cooldownMs = DEFAULT_COOLDOWN_MS): CompactDecider {
  let lastCompactAt = 0;
  return {
    get cooldownMs() {
      return cooldownMs;
    },
    get lastCompactAt() {
      return lastCompactAt;
    },
    decide(contextTokens, contextWindow, now = Date.now()): CompactDecision {
      const threshold = computeCompactThreshold(contextWindow);
      if (threshold === null) {
        return { shouldCompact: false, threshold: 0, contextTokens, reason: "no-window" };
      }
      if (contextTokens <= threshold) {
        return { shouldCompact: false, threshold, contextTokens, reason: "over-threshold" };
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
