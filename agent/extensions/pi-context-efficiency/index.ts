import { truncateHead, truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const MAX_TOOL_BYTES = 5000;
	const KEEP_THINKING_TURNS = 2;

	// R1（message_end 剥离 thinking）已移除：它在消息产生时无法判断新旧轮次，
	// 与 R3「保留最近 KEEP_THINKING_TURNS 轮 thinking」矛盾。统一由 R3 在 context 阶段剪枝。

	pi.on("context", (event) => {
		let messages = event.messages;
		let modified = false;

		let latestSummaryIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as any).role === "compactionSummary") {
				latestSummaryIdx = i;
				break;
			}
		}
		if (latestSummaryIdx >= 0) {
			const hasOlder = messages.slice(0, latestSummaryIdx).some(
				(m: any) => m.role === "compactionSummary",
			);
			if (hasOlder) {
				messages = messages.filter(
					(m: any, i: number) => !(m.role === "compactionSummary" && i !== latestSummaryIdx),
				);
				modified = true;
			}
		}

		const assistantIndices: number[] = [];
		messages.forEach((m: any, i: number) => {
			if (m.role === "assistant") assistantIndices.push(i);
		});
		if (assistantIndices.length > KEEP_THINKING_TURNS) {
			const threshold = assistantIndices[assistantIndices.length - KEEP_THINKING_TURNS];
			messages = messages.map((m: any, i: number) => {
				if (i < threshold && m.role === "assistant" && m.content) {
					const filtered = m.content.filter((b: any) => b.type !== "thinking");
					if (filtered.length < m.content.length) {
						modified = true;
						return { ...m, content: filtered };
					}
				}
				return m;
			});
		}

		if (modified) return { messages };
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" && event.toolName !== "read") return;
		const totalText = event.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("");
		if (Buffer.byteLength(totalText, "utf8") <= MAX_TOOL_BYTES) return;

		const truncate = event.toolName === "bash" ? truncateTail : truncateHead;
		const result = truncate(totalText, { maxBytes: MAX_TOOL_BYTES });
		const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;

		return {
			content: [
				{
					type: "text",
					text: `${result.content}\n\n[...truncated ${omittedBytes} bytes]`,
				} as any,
			],
			details: event.details,
		};
	});

	pi.registerCommand("ping", {
		description: "检查 pi-context-efficiency 是否生效",
		usage: "/ping",
		handler: (_args, ctx) => {
			ctx.ui.notify("pong — pi-context-efficiency active");
		},
	});
}
