/**
 * pi-intervention — 干预捕获扩展（VISION P1 / ROADMAP 4.1，2026-08-26）
 *
 * 目的：用户中途干预（abort）是全系统价值密度最高的信号。本扩展在程序侧捕获
 *       中断快照并与用户的 corrective prompt 关联，为"自主"目标（意图差分析）
 *       和未来 LoRA 训练数据（结构化字段）提供数据底座。
 *
 * 数据流：
 *   before_agent_start   记录用户意图（prompt）；若上一条 abort 快照在关联窗内
 *                        （15min），把本次 prompt 作为 correctivePrompt 回填
 *   tool_execution_start 追踪本轮工具轨迹（名称 + 参数摘要，上限 20 条）
 *   input                捕获 steer 输入（运行中用户插入的纠正指令）
 *   agent_end            最后一条 assistant 消息 stopReason==="aborted" 时落盘快照
 *
 * 落盘：memory/interventions.jsonl（git 忽略；上限 MAX_RECORDS 条，超出淘汰最旧）
 *       字段：id/ts/type/prompt/tools/lastTool/tail/steering/correctivePrompt/
 *            correctedAt/env/cwd —— 结构化字段为 LoRA 铺垫（VISION §6）
 *
 * 缓存纪律：零 system prompt 注入、零时间戳注入；纯被动捕获 + 命令按需读取。
 * 可靠性：所有 handler 静默容错，绝不影响宿主会话。
 *
 * 命令：/intervention recent [N] | stats | help
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_RECORDS = 2000;
const PROMPT_TRUNC = 800;
const TAIL_TRUNC = 400;
const STEERING_MAX = 3;
const STEERING_TRUNC = 300;
const TOOLS_TRACK_MAX = 20;
const TOOL_BRIEF_TRUNC = 120;
export const CORRECTIVE_WINDOW_MS = 15 * 60_000;

/** 解析 interventions.jsonl 路径（PI_INTERVENTIONS_FILE > PI_HOME/memory > ~/.pi/memory） */
export function resolveInterventionsFile(): string {
	const override = process.env.PI_INTERVENTIONS_FILE;
	if (override) return override;
	const repoRoot = process.env.PI_HOME ?? path.join(os.homedir(), ".pi");
	return path.join(repoRoot, "memory", "interventions.jsonl");
}

// ── 类型（结构化最小面，避免耦合内部 Message 类型） ──────────────

interface ToolTouch {
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

interface RunState {
	prompt: string;
	startedAt: number;
	tools: ToolTouch[];
}

// ── 纯函数（导出供测试） ──────────────────────────────────────

export function trunc(text: string, max: number): string {
	if (!text) return "";
	return text.length <= max ? text : text.slice(0, max) + "…";
}

function oneLine(value: unknown): string {
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
		env: {
			platform: process.platform,
			termux: Boolean(process.env.TERMUX_VERSION),
		},
		cwd: process.cwd(),
	};
}

// ── 文件操作（原子写；静默容错由调用方包裹） ────────────────

function readLines(file: string): InterventionRecord[] {
	if (!fs.existsSync(file)) return [];
	const out: InterventionRecord[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* 跳过损坏行 */
		}
	}
	return out;
}

function writeLines(file: string, records: InterventionRecord[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
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

// ── 扩展入口 ────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	const file = resolveInterventionsFile();
	let currentRun: RunState | null = null;
	let lastSteering: string[] = [];
	let lastAborted: { id: string; ts: number } | null = null;

	pi.on("before_agent_start", (event) => {
		try {
			// 关联窗内：新 prompt 视为对上次中断的纠正
			if (lastAborted && Date.now() - lastAborted.ts <= CORRECTIVE_WINDOW_MS) {
				linkCorrective(file, lastAborted.id, event.prompt);
			}
			currentRun = { prompt: event.prompt, startedAt: Date.now(), tools: [] };
			lastSteering = [];
		} catch {
			/* 静默 */
		}
	});

	pi.on("tool_execution_start", (event) => {
		try {
			if (!currentRun) return;
			currentRun.tools.push({
				name: event.toolName,
				brief: trunc(oneLine(event.args), TOOL_BRIEF_TRUNC),
			});
			if (currentRun.tools.length > TOOLS_TRACK_MAX) {
				currentRun.tools = currentRun.tools.slice(-TOOLS_TRACK_MAX);
			}
		} catch {
			/* 静默 */
		}
	});

	pi.on("input", (event) => {
		try {
			// 运行中用户插入的纠正（steer）：价值最高的干预信号
			if ((event as { streamingBehavior?: string }).streamingBehavior === "steer" && event.text) {
				lastSteering.push(trunc(event.text, STEERING_TRUNC));
				if (lastSteering.length > STEERING_MAX) lastSteering = lastSteering.slice(-STEERING_MAX);
			}
		} catch {
			/* 静默 */
		}
	});

	pi.on("agent_end", (event) => {
		try {
			if (!isAbortedEnd(event.messages) || !currentRun) return;
			const record = buildRecord({
				prompt: currentRun.prompt,
				tools: currentRun.tools,
				tail: extractAssistantTail(event.messages),
				steering: lastSteering,
			});
			appendRecord(file, record);
			lastAborted = { id: record.id, ts: Date.now() };
			currentRun = null;
			lastSteering = [];
		} catch {
			/* 静默 */
		}
	});

	pi.registerCommand("intervention", {
		description: "干预捕获：查看中断快照与统计（/intervention help 用法）",
		getArgumentCompletions: () => [
			{ value: "recent", label: "recent", description: "最近 N 条中断快照（默认 5）" },
			{ value: "stats", label: "stats", description: "累计统计（总数/关联率/近7天）" },
			{ value: "help", label: "help", description: "显示用法" },
		],
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const records = readLines(file);

			if (sub === "recent" || sub === undefined || sub === "") {
				const n = Math.min(Math.max(parseInt(rest[0] ?? "5", 10) || 5, 1), 50);
				const recent = records.slice(-n).reverse();
				if (!recent.length) {
					ctx.ui.notify("暂无中断快照记录。", "info");
					return;
				}
				const lines = recent.map((r) => {
					const corr = r.correctivePrompt ? ` →纠正: ${trunc(r.correctivePrompt, 80)}` : " →(未关联)";
					return `[${r.ts}] ${trunc(r.prompt, 100)}\n  工具: ${r.tools.join(", ") || "无"}${corr}`;
				});
				ctx.ui.notify(lines.join("\n\n"), "info");
				return;
			}

			if (sub === "stats") {
				const total = records.length;
				const corrected = records.filter((r) => r.correctivePrompt).length;
				const weekAgo = Date.now() - 7 * 24 * 3600_000;
				const lastWeek = records.filter((r) => new Date(r.ts).getTime() >= weekAgo).length;
				const withSteering = records.filter((r) => r.steering.length).length;
				ctx.ui.notify(
					[
						`中断快照总数: ${total}`,
						`已关联纠正意图: ${corrected}${total ? ` (${Math.round((corrected / total) * 100)}%)` : ""}`,
						`含 steering 纠正: ${withSteering}`,
						`近 7 天: ${lastWeek}`,
						`数据文件: ${file}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(
				["/intervention recent [N]   最近 N 条中断快照（默认 5）", "/intervention stats        累计统计", "/intervention help         本帮助"].join("\n"),
				"info",
			);
		},
	});
}
