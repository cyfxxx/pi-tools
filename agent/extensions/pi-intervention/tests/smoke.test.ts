/**
 * pi-intervention 最小冒烟回归（2026-08-26 审计 MEDIUM：此前该扩展无任何 vitest 覆盖，
 * test-all.sh 的 ALL_EXTS 也未收录——纯靠"index.ts 存在性"检查兜底）。
 * 覆盖：核心纯函数（trunc/extractAssistantTail/isAbortedEnd/buildRecord）与
 * appendRecord/linkCorrective 的落盘语义。handler 注册面由 extensions.test.ts 兜底。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CORRECTIVE_WINDOW_MS,
  trunc,
  extractAssistantTail,
  isAbortedEnd,
  buildRecord,
  appendRecord,
  linkCorrective,
} from "../index.ts";

describe("pi-intervention 冒烟", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-intervention-smoke-"));
    file = join(dir, "interventions.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("CORRECTIVE_WINDOW_MS 为 15 分钟", () => {
    expect(CORRECTIVE_WINDOW_MS).toBe(15 * 60_000);
  });

  it("trunc 截断并保留上限长度", () => {
    expect(trunc("hello", 10)).toBe("hello");
    expect(trunc("x".repeat(50), 10).length).toBeLessThanOrEqual(13); // 含省略标记
    expect(trunc(undefined as unknown as string, 5)).toBe("");
  });

  it("extractAssistantTail 提取最后一条 assistant 文本；isAbortedEnd 识别 aborted", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "partial work…" }] },
    ];
    expect(extractAssistantTail(messages)).toContain("partial work");
    expect(isAbortedEnd(messages.map(m => ({ ...m, stopReason: m.role === "assistant" ? "aborted" : undefined })))).toBe(true);
    expect(isAbortedEnd(messages)).toBe(false);
    expect(isAbortedEnd([])).toBe(false);
  });

  it("buildRecord + appendRecord + linkCorrective 全链路落盘", () => {
    const rec = buildRecord({
      prompt: "do task",
      tools: [{ name: "bash" } as never],
      tail: "partial",
      steering: ["先查一下"],
    });
    expect(rec.type).toBe("abort");
    expect(rec.steering).toEqual(["先查一下"]);
    expect(rec.correctivePrompt).toBeNull();
    const file = join(dir, "interventions.jsonl");
    appendRecord(file, rec);
    expect(existsSync(file)).toBe(true);

    const ok = linkCorrective(file, rec.id, "不要那样做，改用 x", new Date());
    expect(ok).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf-8").trim().split("\n")[0]);
    expect(line.correctivePrompt).toBe("不要那样做，改用 x");

    // 关联窗外的 corrective 不回填
    const farPast = new Date(Date.now() - CORRECTIVE_WINDOW_MS - 1000);
    const ok2 = linkCorrective(file, rec.id, "late", farPast);
    expect(ok2).toBe(false);
  });
});
