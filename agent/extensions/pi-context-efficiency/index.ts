import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const MAX_TOOL_CHARS = 5000;
	const KEEP_THINKING_TURNS = 2;

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const content = event.message.content;
		const nonThinking = content.filter((b: any) => b.type !== "thinking");
		if (nonThinking.length < content.length) {
			return { message: { ...event.message, content: nonThinking } };
		}
	});

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
		if (totalText.length <= MAX_TOOL_CHARS) return;

		let truncated = "";
		for (const c of event.content) {
			if (c.type === "text") {
				const remaining = MAX_TOOL_CHARS - truncated.length;
				if (remaining <= 0) continue;
				truncated += c.text.slice(0, remaining);
			}
		}

		return {
			content: [
				{
					type: "text",
					text: `${truncated}\n[...truncated ${Buffer.byteLength(totalText, "utf8") - Buffer.byteLength(truncated, "utf8")} bytes]`,
				} as any,
			],
		};
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || event.streamingBehavior) return;
		const t = event.text.trim();
		if (/^\/ping$/i.test(t)) {
			ctx.ui.notify("pong — pi-context-efficiency active");
			return { action: "handled" };
		}
	});
}
