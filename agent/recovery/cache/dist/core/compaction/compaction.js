/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */
import { contentText, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.js";
import { buildSessionContext, sessionEntryToContextMessages, } from "../session-manager.js";
import { computeFileLists, createFileOps, extractFileOpsFromMessage, formatFileOperations, SUMMARIZATION_SYSTEM_PROMPT, serializeConversation, } from "./utils.js";
/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(messages, entries, prevCompactionIndex) {
    const fileOps = createFileOps();
    // Collect from previous compaction's details (if pi-generated)
    if (prevCompactionIndex >= 0) {
        const prevCompaction = entries[prevCompactionIndex];
        if (!prevCompaction.fromHook && prevCompaction.details) {
            // fromHook field kept for session file compatibility
            const details = prevCompaction.details;
            if (Array.isArray(details.readFiles)) {
                for (const f of details.readFiles)
                    fileOps.read.add(f);
            }
            if (Array.isArray(details.modifiedFiles)) {
                for (const f of details.modifiedFiles)
                    fileOps.edited.add(f);
            }
        }
    }
    // Extract from tool calls in messages
    for (const msg of messages) {
        extractFileOpsFromMessage(msg, fileOps);
    }
    return fileOps;
}
// ============================================================================
// Message Extraction
// ============================================================================
/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntryForCompaction(entry) {
    if (entry.type === "compaction") {
        return undefined;
    }
    return sessionEntryToContextMessages(entry)[0];
}
function combineUsage(first, second) {
    return {
        input: first.input + second.input,
        output: first.output + second.output,
        cacheRead: first.cacheRead + second.cacheRead,
        cacheWrite: first.cacheWrite + second.cacheWrite,
        ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
            ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
            : {}),
        ...(first.reasoning !== undefined || second.reasoning !== undefined
            ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
            : {}),
        totalTokens: first.totalTokens + second.totalTokens,
        cost: {
            input: first.cost.input + second.cost.input,
            output: first.cost.output + second.cost.output,
            cacheRead: first.cost.cacheRead + second.cost.cacheRead,
            cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
            total: first.cost.total + second.cost.total,
        },
    };
}
export const DEFAULT_COMPACTION_SETTINGS = {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
};
// ============================================================================
// Token calculation
// ============================================================================
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg) {
    if (msg.role === "assistant" && "usage" in msg) {
        const assistantMsg = msg;
        if (assistantMsg.stopReason !== "aborted" &&
            assistantMsg.stopReason !== "error" &&
            assistantMsg.usage &&
            calculateContextTokens(assistantMsg.usage) > 0) {
            return assistantMsg.usage;
        }
    }
    return undefined;
}
/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "message") {
            const usage = getAssistantUsage(entry.message);
            if (usage)
                return usage;
        }
    }
    return undefined;
}
function getLastAssistantUsageInfo(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const usage = getAssistantUsage(messages[i]);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}
/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages) {
    const usageInfo = getLastAssistantUsageInfo(messages);
    if (!usageInfo) {
        let estimated = 0;
        for (const message of messages) {
            estimated += estimateTokens(message);
        }
        return {
            tokens: estimated,
            usageTokens: 0,
            trailingTokens: estimated,
            lastUsageIndex: null,
        };
    }
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
        trailingTokens += estimateTokens(messages[i]);
    }
    return {
        tokens: usageTokens + trailingTokens,
        usageTokens,
        trailingTokens,
        lastUsageIndex: usageInfo.index,
    };
}
/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled)
        return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
// ============================================================================
// Cut point detection
// ============================================================================
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
    if (typeof content === "string") {
        return content.length;
    }
    let chars = 0;
    for (const block of content) {
        if (block.type === "text" && block.text) {
            chars += block.text.length;
        }
        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }
    }
    return chars;
}
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message) {
    let chars = 0;
    switch (message.role) {
        case "user": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "assistant": {
            const assistant = message;
            for (const block of assistant.content) {
                if (block.type === "text") {
                    chars += block.text.length;
                }
                else if (block.type === "thinking") {
                    chars += block.thinking.length;
                }
                else if (block.type === "toolCall") {
                    chars += block.name.length + JSON.stringify(block.arguments).length;
                }
            }
            return Math.ceil(chars / 4);
        }
        case "custom":
        case "toolResult": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "bashExecution": {
            chars = message.command.length + message.output.length;
            return Math.ceil(chars / 4);
        }
        case "branchSummary":
        case "compactionSummary": {
            chars = message.summary.length;
            return Math.ceil(chars / 4);
        }
    }
    return 0;
}
function isCutPointMessage(message) {
    switch (message.role) {
        case "user":
        case "assistant":
        case "bashExecution":
        case "custom":
        case "branchSummary":
        case "compactionSummary":
            return true;
        case "toolResult":
            return false;
    }
    return false;
}
function isTurnStartMessage(message) {
    switch (message.role) {
        case "user":
        case "bashExecution":
        case "custom":
        case "branchSummary":
        case "compactionSummary":
            return true;
        case "assistant":
        case "toolResult":
            return false;
    }
    return false;
}
function isTurnStartEntry(entry) {
    if (entry.type === "compaction") {
        return false;
    }
    return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}
/**
 * Find valid cut points: indices of context-visible user-like or assistant messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(entries, startIndex, endIndex) {
    const cutPoints = [];
    for (let i = startIndex; i < endIndex; i++) {
        const entry = entries[i];
        if (entry.type === "compaction") {
            continue;
        }
        if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
            cutPoints.push(i);
        }
    }
    return cutPoints;
}
/**
 * Find the context-visible user-role message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(entries, entryIndex, startIndex) {
    for (let i = entryIndex; i >= startIndex; i--) {
        if (isTurnStartEntry(entries[i])) {
            return i;
        }
    }
    return -1;
}
/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
    const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
    if (cutPoints.length === 0) {
        return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    // Walk backwards from newest, accumulating estimated message sizes
    let accumulatedTokens = 0;
    let cutIndex = cutPoints[0]; // Default: keep from first message (not header)
    for (let i = endIndex - 1; i >= startIndex; i--) {
        const entry = entries[i];
        const messageTokens = sessionEntryToContextMessages(entry).reduce((sum, message) => sum + estimateTokens(message), 0);
        if (messageTokens === 0)
            continue;
        accumulatedTokens += messageTokens;
        // Check if we've exceeded the budget
        if (accumulatedTokens >= keepRecentTokens) {
            // Find the closest valid cut point at or after this entry
            for (let c = 0; c < cutPoints.length; c++) {
                if (cutPoints[c] >= i) {
                    cutIndex = cutPoints[c];
                    break;
                }
            }
            break;
        }
    }
    // Scan backwards from cutIndex to include adjacent metadata entries that do not affect context.
    while (cutIndex > startIndex) {
        const prevEntry = entries[cutIndex - 1];
        // Stop at compaction boundaries or context-visible entries.
        if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
            break;
        }
        cutIndex--;
    }
    // Determine if this is a split turn
    const cutEntry = entries[cutIndex];
    const startsTurn = isTurnStartEntry(cutEntry);
    const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
    return {
        firstKeptEntryIndex: cutIndex,
        turnStartIndex,
        isSplitTurn: !startsTurn && turnStartIndex !== -1,
    };
}
// ============================================================================
// Summarization
// ============================================================================
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;
/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop contains partial text and must not become a session checkpoint.
 */
export function getSummarizationFailure(response, label) {
    if (response.stopReason === "error") {
        return `${label} failed: ${response.errorMessage || "Unknown error"}`;
    }
    if (response.stopReason === "length") {
        return `${label} failed: generation hit the token cap and the summary is incomplete`;
    }
    return undefined;
}
function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId) {
    const options = { maxTokens, signal, apiKey, headers, env, sessionId };
    if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
        options.reasoning = thinkingLevel;
    }
    return options;
}
/**
 * Shared choke point for every compaction/branch-summary summarization call. Wraps the
 * single LLM call in {@link retryAssistantCall} so transient stream drops (e.g.
 * `terminated`, socket close) honor the configured retry policy instead of failing
 * the whole compaction on the first attempt. Deterministic errors and aborts return
 * immediately (see {@link retryAssistantCall}).
 */
export async function completeSummarization(model, context, options, streamFn, retry, callbacks) {
    // Avoid cache writes for one-off summaries. Reuse caller-supplied routing when available;
    // callers without a session ID, including branch summaries, receive a fresh routing ID.
    const requestOptions = {
        ...options,
        cacheRetention: "none",
        sessionId: options.sessionId ?? uuidv7(),
    };
    const produce = async () => {
        // Patch (patch-compaction-warm-prefix.mjs): 暖前缀重放 onPayload 桥——摘要请求发送前用主请求
        // 最终 payload（缓存键原文）替换自身消息，尾部追加剥离 <conversation> 后的摘要指令；素材由
        // 扩展侧 setCompactionWarmPrefixProvider 提供（未注册/门控拒绝时返回 null → 原生摘要路径）。
        let reqOpts = requestOptions;
        if (typeof options?.onPayload !== "function" && typeof getCompactionWarmPrefix === "function") {
            reqOpts = {
                ...requestOptions,
                onPayload: async (payload) => {
                    try {
                        const wp = getCompactionWarmPrefix();
                        if (!wp || !Array.isArray(wp.messages) || wp.messages.length === 0) return payload;
                        const msgs = payload?.messages;
                        if (!Array.isArray(msgs) || msgs.length === 0) return payload;
                        const last = msgs[msgs.length - 1];
                        const lastText = typeof last?.content === "string"
                            ? last.content
                            : Array.isArray(last?.content)
                                ? last.content.map((b) => (b?.type === "text" ? (b?.text ?? "") : "")).join("\n")
                                : "";
                        if (!(last?.role === "user" && typeof lastText === "string" && lastText.includes("<conversation>"))) return payload;
                        const tail = lastText.replace(/^<conversation>\n[\s\S]*?\n<\/conversation>\n\n/, "");
                        if (!tail || tail === lastText) return payload;
                        const next = { ...payload, messages: [...wp.messages, { role: "user", content: tail }] };
                        if (Array.isArray(wp.tools) && wp.tools.length > 0) next.tools = wp.tools;
                        try {
                            const fs0 = await import("node:fs");
                            fs0.appendFileSync("/root/.pi/logs/warm-diag.jsonl", JSON.stringify({ t: Date.now(), reason: "rewrite-bridge", baseMsgs: wp.messages.length, tailLen: tail.length, tools: Array.isArray(wp.tools) ? wp.tools.length : 0 }) + "\n");
                        } catch {}
                        return next;
                    } catch {
                        return payload;
                    }
                },
            };
        }
        return streamFn
            ? (await streamFn(model, context, reqOpts)).result()
            : completeSimple(model, context, reqOpts);
    };
    return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}
/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId) {
    return (await generateSummaryWithUsage(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId)).text;
}
// Patch (patch-compaction-warm-prefix.mjs): 暖前缀重放注册点——扩展（pi-context）按模型门控注册 provider，
// 返回与主请求同源的 { systemPrompt, tools, messages } 即启用重放；null 回退原生。
let _warmPrefixProvider = null;
export function setCompactionWarmPrefixProvider(fn) {
    _warmPrefixProvider = typeof fn === "function" ? fn : null;
}
function getCompactionWarmPrefix() {
    if (!_warmPrefixProvider) return null;
    try {
        return _warmPrefixProvider();
    } catch {
        return null;
    }
}
/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText) {
    return {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: promptText }],
                timestamp: Date.now(),
            },
        ],
    };
}
/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId) {
    const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
    // Use update prompt if we have a previous summary, otherwise initial prompt
    let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    if (customInstructions) {
        basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }
    // Serialize conversation to text so model doesn't try to continue it
    // Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
    const llmMessages = convertToLlm(currentMessages);
    const conversationText = serializeConversation(llmMessages);
    // Build the prompt with conversation wrapped in tags
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (previousSummary) {
        promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    }
    promptText += basePrompt;
    const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId);
    // Patch (patch-compaction-warm-prefix.mjs): 暖前缀重放退役说明——context 级重放已移除：
    // 历史素材是「转换前」消息时二次转换结构不匹配，是「已转换」最终参数时再次串行化
    // 会重复串行化（v1/v1.5 两版均实测失败）。改为 completeSummarization 内注入 onPayload
    // 桥，在 provider 参数层用主请求最终 payload 整体替换（即缓存键原文），零二次转换。
    const summaryContext = buildSummarizationContext(promptText);
    const response = await completeSummarization(model, summaryContext, completionOptions, streamFn, retry, callbacks);
    const failure = getSummarizationFailure(response, "Summarization");
    if (failure) {
        throw new Error(failure);
    }
    if (response.content.some((block) => block.type === "toolCall")) {
        throw new Error("Summarization attempted to call a tool");
    }
    const textContent = contentText(response.content);
    return { text: textContent, usage: response.usage };
}
export function prepareCompaction(pathEntries, settings) {
    if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
        return undefined;
    }
    let prevCompactionIndex = -1;
    for (let i = pathEntries.length - 1; i >= 0; i--) {
        if (pathEntries[i].type === "compaction") {
            prevCompactionIndex = i;
            break;
        }
    }
    let previousSummary;
    let boundaryStart = 0;
    if (prevCompactionIndex >= 0) {
        const prevCompaction = pathEntries[prevCompactionIndex];
        previousSummary = prevCompaction.summary;
        const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
        boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
    }
    const boundaryEnd = pathEntries.length;
    const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;
    const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
    // Get UUID of first kept entry
    const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
    if (!firstKeptEntry?.id) {
        return undefined; // Session needs migration
    }
    const firstKeptEntryId = firstKeptEntry.id;
    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    // Messages to summarize (will be discarded after summary)
    const messagesToSummarize = [];
    for (let i = boundaryStart; i < historyEnd; i++) {
        const msg = getMessageFromEntryForCompaction(pathEntries[i]);
        if (msg)
            messagesToSummarize.push(msg);
    }
    // Messages for turn prefix summary (if splitting a turn)
    const turnPrefixMessages = [];
    if (cutPoint.isSplitTurn) {
        for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
            const msg = getMessageFromEntryForCompaction(pathEntries[i]);
            if (msg)
                turnPrefixMessages.push(msg);
        }
    }
    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
        return undefined;
    }
    // Extract file operations from messages and previous compaction
    const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
    // Also extract file ops from turn prefix if splitting
    if (cutPoint.isSplitTurn) {
        for (const msg of turnPrefixMessages) {
            extractFileOpsFromMessage(msg, fileOps);
        }
    }
    return {
        firstKeptEntryId,
        messagesToSummarize,
        turnPrefixMessages,
        isSplitTurn: cutPoint.isSplitTurn,
        tokensBefore,
        previousSummary,
        fileOps,
        settings,
    };
}
// ============================================================================
// Main compaction function
// ============================================================================
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 * @param sessionId - Optional routing session ID forwarded without enabling prompt caching
 */
export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, retry, callbacks, sessionId) {
    const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings, } = preparation;
    // Generate summaries and merge into one
    let summary;
    let summaryUsage;
    if (isSplitTurn && turnPrefixMessages.length > 0) {
        let historyText = "No prior history.";
        let historyUsage;
        if (messagesToSummarize.length > 0) {
            const historyResult = await generateSummaryWithUsage(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);
            historyText = historyResult.text;
            historyUsage = historyResult.usage;
        }
        const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId);
        // Merge into single summary
        summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
        summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
    }
    else {
        // Just generate history summary
        const result = await generateSummaryWithUsage(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, retry, callbacks, sessionId);
        summary = result.text;
        summaryUsage = result.usage;
    }
    // Compute file lists and append to summary
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    if (!firstKeptEntryId) {
        throw new Error("First kept entry has no UUID - session may need migration");
    }
    return {
        summary,
        firstKeptEntryId,
        tokensBefore,
        usage: summaryUsage,
        details: { readFiles, modifiedFiles },
    };
}
/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, retry, callbacks, sessionId) {
    const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY); // Smaller budget for turn prefix
    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);
    const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
    const response = await completeSummarization(model, buildSummarizationContext(promptText), createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId), streamFn, retry, callbacks);
    const failure = getSummarizationFailure(response, "Turn prefix summarization");
    if (failure) {
        throw new Error(failure);
    }
    if (response.content.some((block) => block.type === "toolCall")) {
        throw new Error("Turn prefix summarization attempted to call a tool");
    }
    return {
        text: contentText(response.content),
        usage: response.usage,
    };
}
//# sourceMappingURL=compaction.js.map