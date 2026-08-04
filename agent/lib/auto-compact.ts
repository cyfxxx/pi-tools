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
