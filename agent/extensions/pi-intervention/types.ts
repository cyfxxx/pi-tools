/**
 * pi-intervention types — type definitions and constants
 */

export const MAX_RECORDS = 2000;
export const PROMPT_TRUNC = 800;
export const TAIL_TRUNC = 400;
export const STEERING_MAX = 3;
export const STEERING_TRUNC = 300;
export const TOOLS_TRACK_MAX = 20;
export const TOOL_BRIEF_TRUNC = 120;
export const CORRECTIVE_WINDOW_MS = 15 * 60_000;

export interface ToolTouch {
	name: string;
	brief: string;
}

export interface InterventionRecord {
	id: string;
	ts: string;
	type: "abort";
	prompt: string;
	tools: string[];
	lastTool: ToolTouch | null;
	tail: string;
	steering: string[];
	correctivePrompt: string | null;
	correctedAt: string | null;
	env: { platform: string; termux: boolean };
	cwd: string;
}

export interface RunState {
	prompt: string;
	startedAt: number;
	tools: ToolTouch[];
}
