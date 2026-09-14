/**
 * pi-intervention helpers — pure functions for intervention capture
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InterventionRecord, ToolTouch } from "./types.ts";
import {
  MAX_RECORDS,
  PROMPT_TRUNC,
  TAIL_TRUNC,
  STEERING_MAX,
  STEERING_TRUNC,
  TOOLS_TRACK_MAX,
  TOOL_BRIEF_TRUNC,
} from "./types.ts";

/** 解析 interventions.jsonl 路径（PI_INTERVENTIONS_FILE > PI_HOME/memory > ~/.pi/memory） */
export function resolveInterventionsFile(): string {
	const override = process.env.PI_INTERVENTIONS_FILE;
	if (override) return override;
	const repoRoot = process.env.PI_HOME ?? path.join(os.homedir(), ".pi");
	return path.join(repoRoot, "memory", "interventions.jsonl");
}

export function trunc(text: string, max: number): string {
	if (!text) return "";
	return text.length <= max ? text : text.slice(0, max) + "…";
}

export function oneLine(value: unknown): string {
	try {
		const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
		return s.replace(/\s+/g, " ").trim();
	} catch {
		return "";
	}
}

/** 从 agent_end 的 messages 中提取最后一条 assistant 文本尾部 */
export function extractAssistantTail(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown; stopReason?: string };
		if (m?.role !== "assistant") continue;
		let text = "";
		if (typeof m.content === "string") {
			text = m.content;
		} else if (Array.isArray(m.content)) {
			text = m.content
				.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
				.filter(Boolean)
				.join("\n");
		}
		return trunc(text.trim(), TAIL_TRUNC);
	}
	return "";
}

/** 判定 agent_end 是否为用户中断 */
export function isAbortedEnd(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string };
		if (m?.role === "assistant") return m.stopReason === "aborted";
	}
	return false;
}

export function buildRecord(input: {
	prompt: string;
	tools: ToolTouch[];
	tail: string;
	steering: string[];
	now?: Date;
}): InterventionRecord {
	const now = input.now ?? new Date();
	return {
		id: `iv_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
		ts: now.toISOString(),
		type: "abort",
		prompt: trunc(input.prompt, PROMPT_TRUNC),
		tools: input.tools.slice(-10).map((t) => t.name),
		lastTool: input.tools.length ? input.tools[input.tools.length - 1] : null,
		tail: input.tail,
		steering: input.steering.slice(-STEERING_MAX),
		correctivePrompt: null,
		correctedAt: null,
		env: { platform: os.platform(), termux: process.env.TERMUX_VERSION !== undefined },
		cwd: process.cwd(),
	};
}

export function readLines(file: string): InterventionRecord[] {
	if (!fs.existsSync(file)) return [];
	const raw = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
	const out: InterventionRecord[] = [];
	for (const line of raw) {
		try {
			out.push(JSON.parse(line));
		} catch {
			/* skip */
		}
	}
	return out;
}

export function writeLines(file: string, records: InterventionRecord[]): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	fs.renameSync(tmp, file);
}

export function appendRecord(file: string, record: InterventionRecord): void {
	const records = readLines(file);
	records.push(record);
	writeLines(file, records.slice(-MAX_RECORDS));
}

/** 把 corrective prompt 回填到指定 abort 记录（15min 关联窗内的新意图即纠正意图） */
export function linkCorrective(file: string, id: string, correctivePrompt: string, now?: Date): boolean {
	const records = readLines(file);
	const idx = records.findIndex((r) => r.id === id);
	if (idx < 0 || records[idx].correctivePrompt) return false;
	records[idx].correctivePrompt = trunc(correctivePrompt, PROMPT_TRUNC);
	records[idx].correctedAt = (now ?? new Date()).toISOString();
	writeLines(file, records);
	return true;
}
