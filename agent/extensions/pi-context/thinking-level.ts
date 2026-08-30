/**
 * thinking 档位自适应切档（task #25，2026-08-21）
 *
 * 背景：thinking 档位（high/medium/low）决定每轮思考 token 预算，与缓存命中/A 类
 * 剪枝断裂强相关。max→high 实测有效后，改为按上下文压力自动升降档位：
 *   - 降挡：上下文持续 critical（真实窗口比例≥95%）→ 降一档。critical 时
 *     thinking 预算会与上下文空间争抢、触发 thinking 剪枝（A 类断裂主因），降档
 *     可同时省 token 并降低剪枝概率。
 *   - 升回：压力回落 low（ratio<70%）且连续稳定 → 升一档，最高到本会话基准档位。
 *   - 防抖：切换后死区窗口内不再次切换（规避档位跳变加剧剪枝不确定性）。
 * 2026-08-30 用户策略修订：ratio 分母为真实上下文窗口（resolved.window，本环境 1M），
 * 不再对齐 256K 压缩阈值——阈值只是运维提示，不代表模型能力上限；
 * 此前按 256K 比例在 tokens≈264K（真实 26%）即误判 critical 降档。
 *
 * 压力信号说明：不使用 context-budget.getBudgetReport().pressure——其 usedTotal 为
 * 单调不回退设计（压缩后不回落，仅支持压力上涨信号），会导致升回永不触发。
 * 改用每轮真实 tokens/window 比例（agent_settled resolveContext 提供，压缩后自然
 * 回落）直接驱动。
 *
 * 记账：每次切换走 usage-diag recordLevelChange（from/to/reason/pressure 强制落盘）；
 * 切换后思考量变化由 thinking-meter 持续记账自动关联。
 *
 * 缓存影响：档位是运行时 provider 设置、不进注入面 → 切换不额外破坏缓存前缀。
 * 副作用：内核 setThinkingLevel 实际变化时会持久化 settings.defaultThinkingLevel
 * （合法值为 off/minimal/low/medium/high，无 max），自动切档会在 settings 落盘——
 * 属预期（自适应档位取代人工固定档）。
 */
import { recordLevelChange } from "../../lib/usage-diag.ts";
import { getBudgetReport } from "../../lib/context-budget.ts";

/** 自动控制使用的档位阶梯（minimal/low 之间保护接口下限 = low，不落到 minimal/off） */
export const LEVEL_LADDER = ["low", "medium", "high"] as const;
export type AutoThinkLevel = (typeof LEVEL_LADDER)[number];

/** 压力阈值：ratio>=CRITICAL_RATIO 降挡；ratio<LOW_RATIO 视为回落（对照 context-budget 的 70/85/95） */
export const CRITICAL_RATIO = 0.95;
export const LOW_RATIO = 0.7;
/** 防抖死区：切换后此时间窗内不再次切换（ms） */
export const MIN_INTERVAL_MS = 90_000;
/** 连续 critical 才降挡（防单次偶发高压误降） */
export const CRITICAL_STREAK = 2;
/** 连续 low 且稳定才升回（防抖） */
export const LOW_STREAK = 3;

export interface ThinkLevelState {
  /** 会话基调档位：初始化取运行时档位（clamp），升回上限，不随持久化漂移 */
  base: AutoThinkLevel;
  current: AutoThinkLevel;
  criticalStreak: number;
  lowStreak: number;
  lastSwitchTs: number;
}

/** 将任意档位字符串 clamp 进阶梯（max→high、off/minimal/低档→low 下限保护） */
export function clampToLadder(level: string, fallback: AutoThinkLevel = "high"): AutoThinkLevel {
  const i = LEVEL_LADDER.indexOf(level as AutoThinkLevel);
  if (i >= 0) return level as AutoThinkLevel;
  // 高于 high（如 max）→ high；低于 low（off/minimal）→ low；未知 → fallback
  if (level === "max") return "high";
  if (level === "minimal" || level === "off") return "low";
  return fallback;
}

export function createState(initialLevel: string): ThinkLevelState {
  const base = clampToLadder(initialLevel);
  return { base, current: base, criticalStreak: 0, lowStreak: 0, lastSwitchTs: 0 };
}

function idx(l: AutoThinkLevel): number {
  return LEVEL_LADDER.indexOf(l);
}

export function lower(l: AutoThinkLevel): AutoThinkLevel | null {
  const i = idx(l);
  return i <= 0 ? null : LEVEL_LADDER[i - 1];
}

export function upper(l: AutoThinkLevel): AutoThinkLevel | null {
  const i = idx(l);
  return i >= LEVEL_LADDER.length - 1 ? null : LEVEL_LADDER[i + 1];
}

/** 由真实比例推导压力带：critical/low/其余 */
export function pressureOf(ratio: number): "critical" | "low" | "mid" {
  if (ratio >= CRITICAL_RATIO) return "critical";
  if (ratio < LOW_RATIO) return "low";
  return "mid";
}

/**
 * 每次 agent_settled 调用一次（附当前真实 tokens/window 比例）。返回切换到的档位；未切换返回 null。
 */
export function tickThinkingLevel(
  state: ThinkLevelState,
  ratio: number,
  setLevel: (l: AutoThinkLevel) => void,
  now: number = Date.now(),
): AutoThinkLevel | null {
  const p = pressureOf(ratio);

  if (now - state.lastSwitchTs < MIN_INTERVAL_MS) {
    // 死区内：不切换，也不累计连续信号（避免解除死区瞬间被旧信号误触发）
    return null;
  }

  if (p === "critical") {
    state.criticalStreak += 1;
    state.lowStreak = 0;
    if (state.criticalStreak >= CRITICAL_STREAK) {
      const next = lower(state.current);
      if (next) {
        state.criticalStreak = 0;
        return apply(state, next, `pressure=critical(ratio=${Math.round(ratio * 100)}%)`, "critical", setLevel, now);
      }
      // 已到下限：清零但不切
      state.criticalStreak = 0;
    }
    return null;
  }

  if (p === "low") {
    state.lowStreak += 1;
    state.criticalStreak = 0;
    if (state.lowStreak >= LOW_STREAK) {
      const next = upper(state.current);
      if (next && idx(next) <= idx(state.base)) {
        state.lowStreak = 0;
        return apply(state, next, `pressure=low(稳定回升至基准)`, "low", setLevel, now);
      }
      // 已到基准/顶：清零但不越基
      state.lowStreak = 0;
    }
    return null;
  }

  // 中段压力：不触发升降，清计数
  state.criticalStreak = 0;
  state.lowStreak = 0;
  return null;
}

function apply(
  state: ThinkLevelState,
  next: AutoThinkLevel,
  reason: string,
  pressure: string,
  setLevel: (l: AutoThinkLevel) => void,
  now: number,
): AutoThinkLevel {
  const from = state.current;
  setLevel(next);
  state.current = next;
  state.lastSwitchTs = now;
  recordLevelChange({ from, to: next, reason, pressure, source: "auto" });
  return next;
}

// ── 混合方案（2026-08-21）：模型提议、规则审批 ──
// 暴露 thinking_level 工具给模型，但模型只可"建议"：
//   - 目标档位 clamp 进阶梯（low/medium/high，防模型关到 off/minimal）；
//   - 死区外才放行（防模型高频反复切档）；
//   - 与压力信号冲突拒绝：critical 时升档、low 时降档均拒绝（尊重上下文现实）；
//   - 全部经 recordLevelChange(source=model) 强制落盘审计。
export interface ProposalResult {
  ok: boolean;
  message: string;
  level?: AutoThinkLevel;
}

export function proposeThinkingLevel(
  state: ThinkLevelState,
  target: string,
  reason: string,
  setLevel: (l: AutoThinkLevel) => void,
  now: number = Date.now(),
): ProposalResult {
  const level = clampToLadder(target);
  const from = state.current;
  if (level === from) {
    return { ok: true, message: `已是 ${level} 档，无需切换。` };
  }
  const elapsed = now - state.lastSwitchTs;
  if (elapsed < MIN_INTERVAL_MS) {
    return {
      ok: false,
      message: `防抖死区内（还需 ${Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000)}s）不切档，请稍后再试。当前 ${from} 档。`,
    };
  }
  // 方向与压力一致性（用预算报告作定性信号）：仅拒绝明确有害的
  // "critical 时升档"（高压升档会加剧 thinking 剪枝/断裂）；其余方向（含
  // 压力较小时降档省 token）由模型理由驱动、靠死区+clamp 兜底防滥用。
  const pressure = getBudgetReport().pressure;
  if (pressure === "critical" && idx(level) > idx(from)) {
    return {
      ok: false,
      message: `当前上下文压力 critical（极高），升档只会加剧 thinking 剪枝/断裂，已拒绝升到 ${level}。建议保持 ${from} 或降档缓解。`,
    };
  }
  // 放行：模型主动切档强记账
  setLevel(level);
  state.current = level;
  state.lastSwitchTs = now;
  recordLevelChange({
    from,
    to: level,
    reason: `model-proposal: ${reason || "(未注明理由)"}`.slice(0, 120),
    pressure,
    source: "model",
  });
  return { ok: true, message: `已按模型提议切换到 ${level} 档（reason: ${reason || "未注明"}）。`, level };
}
