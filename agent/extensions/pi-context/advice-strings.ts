/**
 * 执行效率指令（静态注入，缓存友好）
 */
export const EFFICIENCY_ADVICE = `## Execution Efficiency

- Independent tool calls (multiple reads, greps, globs) MUST be issued in a single assistant turn — batch them together; a parallel batch costs only one request.
- During exploration/execution turns, do NOT write explanatory text or progress reports — output tool calls only. Summarize once when everything is done.
- Exception: when todo progress updates are required or a plan summary is requested, output the required structured summary.
- Long exploration dead-ends: if multiple reads/greps yield no conclusion, delegate exploration to subagent (scout) to keep the main context clean.`;

/**
 * 低压力精简版委托建议（静态注入，缓存友好）
 */
export const LOW_PRESSURE_DELEGATION = `## Proactive Delegation

- Codebase exploration / pure research → \`subagent\` (\`scout\`) — isolated context, compressed summary.
- Independent subtasks → \`subagent\` parallel mode; multi-step workflows → chain (scout→planner→worker).
- Reading >3 files or heavy refactors → delegate to keep the main context clean.`;

/** 完整委托建议（含场景表 + 决策启发式），仅在压力档位（≥75% 阈值）注入 */
export const FULL_DELEGATION_ADVICE = `## Proactive Delegation

You have access to \`subagent\` tool with specialized agents (scout, planner, worker, reviewer). Use them proactively:

| Scenario | Action | Why |
|----------|--------|-----|
| Codebase exploration ("find where X is", "how does Y work") | Call \`subagent\` with \`scout\` agent | Scout runs in isolated context, returns compressed summary — keeps your main context clean |
| 2+ independent subtasks | Call \`subagent\` parallel mode | Runs tasks one at a time in isolated contexts instead of N sequential turns that bloat the main conversation |
| Multi-step implementation | Call \`subagent\` chain: scout→planner→worker | Each step has isolated context, no context pollution |
| Reading many files (>3) | Delegate to a worker agent instead | Keeps your context window clean and focused |
| Pure research ("explain architecture") | Delegate entirely to scout agent | Consume only the compressed summary |

**Decision heuristic:**
- Ask yourself: "Can this task be done in an isolated context?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Will this task make my context window >70% full?"
- If yes → delegate to \`subagent\`
- Ask yourself: "Are there independent sub-tasks?"
- If yes → parallel \`subagent\``;
