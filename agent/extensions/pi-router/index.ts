import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const usage = ctx.getContextUsage();
		let tokenHint = "";
		if (usage && usage.tokens !== null && usage.contextWindow > 0) {
			const remaining = usage.contextWindow - usage.tokens;
			const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
			tokenHint = `\n[Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%). ~${remaining.toLocaleString()} tokens remain. If context is tight, delegate aggressively to subagents.]`;
		}

		const delegationAdvice = `## Proactive Delegation${tokenHint}

You have access to \`subagent\` tool with specialized agents (scout, planner, worker, reviewer). Use them proactively:

| Scenario | Action | Why |
|----------|--------|-----|
| Codebase exploration ("find where X is", "how does Y work") | Call \`subagent\` with \`scout\` agent | Scout uses cheap Haiku, returns compressed summary — 20x cheaper than Sonnet doing the search |
| 2+ independent subtasks | Call \`subagent\` parallel mode | Run N tasks concurrently instead of N turns sequentially |
| Multi-step implementation | Call \`subagent\` chain: scout→planner→worker | Each step has isolated context, no context pollution |
| Reading many files (>3) | Delegate to a worker agent instead | Keeps your context window clean and focused |
| Pure research ("explain architecture") | Delegate entirely to scout agent | Consume only the compressed summary |

**Decision heuristic:**
- Ask yourself: "Can this task be done by a cheaper model in isolation?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Will this task make my context window >70% full?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Are there independent sub-tasks?"
- If yes → parallel \`subagent\``;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + delegationAdvice,
		};
	});
}
