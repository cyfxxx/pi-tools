/**
 * 工具输出截断模块 - 处理工具输出的压缩和截断
 */

import { truncateHead, truncateTail, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { compactJson, MARK_BUDGET } from "./compression.ts";

// 错误输出配置
export const ERROR_MARK_RE = /(^|\n)\s*(Error|ERROR|Traceback \(most recent call last\)|error:)/;
export const ERROR_LINE_MAX = 800;
export const ERROR_LINE_KEEP = 240;
export const FAIL_STREAK_LIMIT = 3;

// 静态提示文本
export const FAIL_BREAKER_HINT = "\n\n→ 熔断提示：同一工具已连续失败 3 次以上。停止重复尝试：先检查前置条件（路径/权限/网络/参数）或改用替代方案；再次失败应暂停并向用户说明。";
export const DEHYDRATE_HINT = "\n→ 错误已精简；连续失败时优先参考记忆库 [solutions] 条目。";

// 失败计数状态
const failStreak = new Map<string, number>();

/** 更新失败连击：返回触发熔断的提示 */
export function updateFailStreak(
  streak: Map<string, number>,
  toolName: string,
  isError: boolean,
): { n: number; hint?: string } {
  if (!isError) {
    streak.delete(toolName);
    return { n: 0 };
  }
  const n = (streak.get(toolName) ?? 0) + 1;
  streak.set(toolName, n);
  return n === FAIL_STREAK_LIMIT ? { n, hint: FAIL_BREAKER_HINT } : { n };
}

/** 错误输出确定性脱水 */
function dehydrateErrorOutput(text: string): string | undefined {
  if (!ERROR_MARK_RE.test(text)) return undefined;
  const lines = text.split("\n");
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run++;
    if (run > 2) {
      out.push(line, line, `[...${run - 2} 行重复已折叠]`);
      changed = true;
    } else if (Buffer.byteLength(line, "utf8") > ERROR_LINE_MAX) {
      out.push(`${line.slice(0, ERROR_LINE_KEEP)}...[行截断]`);
      changed = true;
    } else {
      out.push(line);
    }
    i += run;
  }
  return changed ? out.join("\n") : undefined;
}

/** 原位重建：合并 text 到第一个 text 块位置 */
function rebuildTextContent(
  content: ToolResultEvent["content"],
  text: string,
): ToolResultEvent["content"] {
  const rebuilt: ToolResultEvent["content"] = [];
  let textPlaced = false;
  for (const c of content) {
    if (c.type === "text") {
      if (!textPlaced) {
        rebuilt.push({ type: "text", text });
        textPlaced = true;
      }
    } else {
      rebuilt.push(c);
    }
  }
  if (!textPlaced) rebuilt.push({ type: "text", text });
  return rebuilt;
}

/** 内容尾部追加文本块 */
function appendText(
  content: ToolResultEvent["content"],
  text: string,
): ToolResultEvent["content"] {
  return [...content, { type: "text", text }];
}

/**
 * R4 工具输出截断的纯函数：超限时截断文本块
 */
export function truncateToolContent(
  toolName: string,
  content: ToolResultEvent["content"],
  cap: number,
): { content: ToolResultEvent["content"]; omittedBytes: number } | undefined {
  const totalText = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (Buffer.byteLength(totalText, "utf8") <= cap) return undefined;

  // 内容路由分支 1：JSON 结构性压缩
  const jsonCompact = compactJson(totalText, cap);
  if (jsonCompact !== undefined) {
    return { content: rebuildTextContent(content, jsonCompact.text), omittedBytes: jsonCompact.omittedBytes };
  }
  // 内容路由分支 2：错误脱水
  const dehy = dehydrateErrorOutput(totalText);
  if (dehy !== undefined && Buffer.byteLength(dehy, "utf8") <= cap) {
    const omitted = Buffer.byteLength(totalText, "utf8") - Buffer.byteLength(dehy, "utf8");
    if (omitted > 0) {
      return { content: rebuildTextContent(content, dehy + DEHYDRATE_HINT), omittedBytes: omitted };
    }
  }

  // 通用截断
  const base = dehy ?? totalText;
  const truncate = toolName === "bash" ? truncateTail : truncateHead;
  const result = truncate(base, { maxBytes: Math.max(1, cap - MARK_BUDGET) });
  const omittedBytes = Buffer.byteLength(totalText, "utf8") - result.outputBytes;
  const truncatedText = `${result.content}\n\n[...truncated ${omittedBytes} bytes]`;

  return {
    content: rebuildTextContent(content, truncatedText),
    omittedBytes,
  };
}

/** 导出 appendText 供外部使用 */
export { appendText };
