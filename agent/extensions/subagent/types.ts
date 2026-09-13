import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentScope } from "./agents.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type RiskLevel = "1σ" | "2σ" | "3σ";

export interface SubagentToolParams {
	agent?: string;
	task?: string;
	tasks?: { agent?: string; task: string; cwd?: string }[];
	chain?: { agent?: string; task: string; cwd?: string }[];
	agentScope?: AgentScope;
	cwd?: string;
}
