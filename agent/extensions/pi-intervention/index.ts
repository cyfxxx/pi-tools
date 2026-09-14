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
 *
 * 缓存纪律：零 system prompt 注入、零时间戳注入；纯被动捕获 + 命令按需读取。
 * 可靠性：所有 handler 静默容错，绝不影响宿主会话。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunState } from "./types.ts";
import { CORRECTIVE_WINDOW_MS } from "./types.ts";
import {
  trunc,
  oneLine,
  extractAssistantTail,
  isAbortedEnd,
  buildRecord,
  readLines,
  appendRecord,
  linkCorrective,
  resolveInterventionsFile,
} from "./helpers.ts";

export { CORRECTIVE_WINDOW_MS } from "./types.ts";
export { resolveInterventionsFile, trunc, extractAssistantTail, isAbortedEnd, buildRecord, appendRecord, linkCorrective } from "./helpers.ts";
export type { InterventionRecord } from "./types.ts";

export default async function (pi: ExtensionAPI) {
	const file = resolveInterventionsFile();
	let currentRun: RunState | null = null;
	let lastSteering: string[] = [];
	let lastAborted: { id: string; ts: number } | null = null;

	pi.on("before_agent_start", (event) => {
		try {
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
				brief: trunc(oneLine(event.args), 120),
			});
			if (currentRun.tools.length > 20) {
				currentRun.tools = currentRun.tools.slice(-20);
			}
		} catch {
			/* 静默 */
		}
	});

	pi.on("input", (event) => {
		try {
			if ((event as { streamingBehavior?: string }).streamingBehavior === "steer" && event.text) {
				lastSteering.push(trunc(event.text, 300));
				if (lastSteering.length > 3) lastSteering = lastSteering.slice(-3);
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
		getArgumentCompletions: (prefix) => {
			const first = (prefix?.trim().split(/\s+/)[0] ?? "").toLowerCase();
			const items = [
				{ value: "recent", label: "recent", description: "最近 N 条中断快照（默认 5）" },
				{ value: "stats", label: "stats", description: "累计统计（总数/关联率/近7天）" },
				{ value: "help", label: "help", description: "显示用法" },
			];
			if (!prefix?.includes(" ")) {
				return items.filter((i) => i.value.startsWith(first));
			}
			return [];
		},
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
