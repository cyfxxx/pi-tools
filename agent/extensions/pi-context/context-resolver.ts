/** 读取 0-1 比例环境变量 */
export function readEnvRatio(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}

export interface ResolvedContext {
  tokens: number;
  window: number;
}

/** 解析会话上下文信息 */
export function resolveContext(
  ctx: { getContextUsage?: () => unknown },
  lastProviderContextTokens: number,
  fallbackContextWindow: number,
): ResolvedContext | null {
  const usage = ctx.getContextUsage?.() as
    | { tokens?: number | null; contextWindow?: number; percent?: number | null }
    | undefined;
  if (
    usage &&
    typeof usage.tokens === "number" &&
    usage.tokens > 0 &&
    typeof usage.contextWindow === "number" &&
    usage.contextWindow > 0
  ) {
    return { tokens: usage.tokens, window: usage.contextWindow };
  }
  if (lastProviderContextTokens > 0) {
    return { tokens: lastProviderContextTokens, window: fallbackContextWindow };
  }
  return null;
}
