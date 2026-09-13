import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.js";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.js";
import { theme } from "../theme/theme.js";
/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text) {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}
/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
export function formatCwdForFooter(cwd, home) {
    if (!home)
        return cwd;
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const isInsideHome = relativeToHome === "" ||
        (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
    if (!isInsideHome)
        return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent {
    autoCompactEnabled = true;
    session;
    footerData;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }
    setSession(session) {
        this.session = session;
    }
    setAutoCompactEnabled(enabled) {
        this.autoCompactEnabled = enabled;
    }
    /**
     * No-op: git branch caching now handled by provider.
     * Kept for compatibility with existing call sites in interactive-mode.
     */
    invalidate() {
        // No-op: git branch is cached/invalidated by provider
    }
    /**
     * Clean up resources.
     * Git watcher cleanup now handled by provider.
     */
    dispose() {
        // Git watcher cleanup handled by provider
    }
    render(width) {
        const state = this.session.state;
        // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
        const usageTotals = createUsageTotals();
        let latestCacheHitRate;
        for (const entry of this.session.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                addUsageToTotals(usageTotals, entry.message.usage);
                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
                latestCacheHitRate =
                    latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
            }
            else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
                addUsageToTotals(usageTotals, entry.message.usage);
            }
            else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
                addUsageToTotals(usageTotals, entry.usage);
            }
        }
        // Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        const contextUsage = this.session.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        // Replace home directory with ~
        let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        // Add git branch if available
        const branch = this.footerData.getGitBranch();
        if (branch) {
            pwd = `${pwd} (${branch})`;
        }
        // Add session name if set
        const sessionName = this.session.sessionManager.getSessionName();
        if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
        }
// Patch (patch-footer-format.mjs): 前 3 字段改为 Σ总输入(prompt 总量=命中+未命中) / ↑累计未命中 / ↓累计输出；R/W 合并进"Σ"（明细见 CH 与 /session）。
        const sessionPromptTotal = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
        const statsParts = [];
        if (sessionPromptTotal > 0)
            statsParts.push(`Σ${formatTokens(sessionPromptTotal)}`);
        if (usageTotals.input)
            statsParts.push(`↑${formatTokens(usageTotals.input)}`);
        if (usageTotals.output)
            statsParts.push(`↓${formatTokens(usageTotals.output)}`);
        // Patch (patch-footer-cache.mjs): CH 实时/会话双命中率（实时=最新一条 assistant 消息，会话=全部条目累计）。↑↓RW$ 保持累计口径。
            const sessionPromptTokens = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
            const sessionCacheHitRate =
                sessionPromptTokens > 0 ? (usageTotals.cacheRead / sessionPromptTokens) * 100 : undefined;
            if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && (latestCacheHitRate !== undefined || sessionCacheHitRate !== undefined)) {
                const hitRates = [];
                if (latestCacheHitRate !== undefined) hitRates.push(latestCacheHitRate.toFixed(1));
                if (sessionCacheHitRate !== undefined) hitRates.push(sessionCacheHitRate.toFixed(1));
                statsParts.push(`CH${hitRates.join("/")}%`);
            }
        // Kimi Coding is subscription-backed despite using API-key authentication.
        const usingSubscription = state.model
            ? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
            : false;
        if (usageTotals.cost || usingSubscription) {
// Patch (patch-footer-format.mjs): 成本换算人民币（近似汇率常量；usageTotals.cost 为 USD，改汇率编辑下一行）
            const CNY_PER_USD = 6.77;
            const costStr = `¥${(usageTotals.cost * CNY_PER_USD).toFixed(2)}${usingSubscription ? " (sub)" : ""}`;
            statsParts.push(costStr);
        }
        // Colorize context percentage based on usage
        let contextPercentStr;
        const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
        // Patch (patch-footer-live-context.mjs) V3: 实时上下文显示——分母恒为真实上下文窗口（压缩线不是窗口，显示 x/256k 会误导）。
// 自动压缩参考线 PI_CONTEXT_ABSOLUTE_TOKENS 默认 256K 仅用于着色预警：达线黄、超窗80%红+!!。
// 达线≠必然压缩（普通压缩受完成/后台/空闲三重门限约束）；压缩后 tokens=null 显示 "?"。
    const compactLine = (() => {
        const raw = process.env.PI_CONTEXT_ABSOLUTE_TOKENS;
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) && n > 0 ? n : 256000;
    })();
    const effWindow = contextWindow > 0 ? contextWindow : compactLine; // 即真实窗口（历史变量名，下游 cache/restart-hint 补丁引用）
    const liveTokens = contextUsage?.tokens;
    const liveTokensStr =
        liveTokens !== null && liveTokens !== undefined && effWindow > 0
            ? `${formatTokens(liveTokens)}/`
            : "";
            const effPercent = (liveTokens !== null && liveTokens !== undefined && effWindow > 0)
                ? String(Math.round((liveTokens / effWindow) * 1000) / 10)
                : contextPercent;
            // Patch (patch-footer-restart-hint.mjs): 上下文 >40% 窗口时在 context 区追加 "⚠"（重启后首轮必全量重发，建议先 /compact；>70% 已有黄/红着色）。
                const restartHint = contextPercent !== "?" && contextPercentValue > 40 && contextPercentValue <= 70 ? " ⚠" : "";
                const contextPercentDisplay = contextPercent === "?"
                    ? `?/${formatTokens(effWindow)}${autoIndicator}`
                    : `${liveTokensStr}${formatTokens(effWindow)}${autoIndicator}${restartHint}`;
        // Patch (patch-footer-live-context.mjs) V3.1 着色: 双指标——黄=达自动压缩参考线(256K)；红=超真实窗口 80%（溢出预警，优先级更高，超窗加!!）。
// 显示分母仍为真实窗口；两指标口径独立（小窗口模型红会先于黄触发，自洽）。
    const linePct = (liveTokens !== null && liveTokens !== undefined && compactLine > 0)
        ? (liveTokens / compactLine) * 100
        : -1;
    const winPct = (liveTokens !== null && liveTokens !== undefined && contextWindow > 0)
        ? (liveTokens / contextWindow) * 100
        : contextPercentValue;
    if ((winPct > 80 || contextPercentValue > 90)) {
        if (winPct > 100) {
            contextPercentStr = theme.fg("error", contextPercentDisplay + " !!");
        }
        else {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
        }
    }
    else if (linePct >= 100) {
        contextPercentStr = theme.fg("warning", contextPercentDisplay);
    }
    else {
        contextPercentStr = contextPercentDisplay;
    }
        statsParts.push(contextPercentStr);
        if (areExperimentalFeaturesEnabled()) {
            statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
        }
        let statsLeft = statsParts.join(" ");
        // Add model name on the right side, plus thinking level if model supports it
        const modelName = state.model?.id || "no-model";
        let statsLeftWidth = visibleWidth(statsLeft);
        // If statsLeft is too wide, truncate it
        if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
        }
        // Calculate available space for padding (minimum 2 spaces between stats and model)
        const minPadding = 2;
        // Add thinking level indicator if model supports reasoning
        let rightSideWithoutProvider = modelName;
        if (state.model?.reasoning) {
            const thinkingLevel = state.thinkingLevel || "off";
            rightSideWithoutProvider =
                thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        // Prepend the provider in parentheses if there are multiple providers and there's enough room
        let rightSide = rightSideWithoutProvider;
        if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
            rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
                // Too wide, fall back
                rightSide = rightSideWithoutProvider;
            }
        }
        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine;
        if (totalNeeded <= width) {
            // Both fit - add padding to right-align model
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
        }
        else {
            // Need to truncate right side
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
                const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
                const truncatedRightWidth = visibleWidth(truncatedRight);
                const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
                statsLine = statsLeft + padding + truncatedRight;
            }
            else {
                // Not enough space for right side at all
                statsLine = statsLeft;
            }
        }
        // Apply dim to each part separately. statsLeft may contain color codes (for context %)
        // that end with a reset, which would clear an outer dim wrapper. So we dim the parts
        // before and after the colored section independently.
        const dimStatsLeft = theme.fg("dim", statsLeft);
        const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
        const dimRemainder = theme.fg("dim", remainder);
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
        const lines = [pwdLine, dimStatsLeft + dimRemainder];
        // Add extension statuses on a single line, sorted by key alphabetically
        const extensionStatuses = this.footerData.getExtensionStatuses();
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            // Truncate to terminal width with dim ellipsis for consistency with footer style
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        return lines;
    }
}
//# sourceMappingURL=footer.js.map