/**
 * 纯函数：从上下文消息提取最后一条实质 user 请求
 */
export function extractUserRequest(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    const c = m.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((p) =>
          typeof p === "string" ? p : (p as { text?: string })?.text ?? "",
        )
        .join(" ");
    }
    if (text.trim()) return text.trim().slice(0, 200);
  }
  return "";
}
