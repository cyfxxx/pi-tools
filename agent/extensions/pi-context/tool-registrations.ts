import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { enabledGroups, applyToolLayering, buildToolsReport } from "./tool-layering.ts";
import { recordToolEnable } from "./diagnostics.ts";
import { LEVEL_LADDER, createState, proposeThinkingLevel } from "./thinking-level.ts";

export function registerToolRegistrations(
  pi: ExtensionAPI,
  thinkStateRef: { current: any },
): void {
  pi.registerTool({
    name: "enable_tool",
    label: "启用休眠工具组",
    description:
      "启用休眠工具组（browser/admin/autopilot/link）。启用后工具列表更新一次（前缀缓存重算），本会话内保持，重启恢复默认分层；已启用的组再次启用无副作用。",
    parameters: {
      type: "object",
      properties: {
        group: {
          type: "string",
          enum: ["browser", "admin", "autopilot", "link"],
          description: "要启用的休眠工具组名",
        },
      },
      required: ["group"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const group = params?.group as string | undefined;
      const { SLEEPING_GROUPS } = require("./tool-groups.ts");
      const g = SLEEPING_GROUPS.find((x: any) => x.name === group);
      if (!g) {
        return {
          content: [
            {
              type: "text",
              text: `未知工具组: ${group ?? "(空)"}。可用组: ${SLEEPING_GROUPS.map((x: any) => x.name).join(", ")}`,
            },
          ],
          isError: true,
          details: null,
        };
      }
      if (enabledGroups.has(g.name)) {
        return {
          content: [{ type: "text", text: `工具组 ${g.name} 已在启用状态（${g.tools.join(", ")}），无操作。` }],
          details: null,
        };
      }
      enabledGroups.add(g.name);
      applyToolLayering(pi as any);
      recordToolEnable(g.name, "enable_tool");
      return {
        content: [
          {
            type: "text",
            text: `已启用工具组 ${g.name}: ${g.tools.join(", ")}。本会话内保持可用；重启 pi 后恢复默认分层（如需常驻可后续调整工具分组配置）。`,
          },
        ],
        details: null,
      };
    },
  });

  pi.registerTool({
    name: "thinking_level",
    label: "调整思考档位（模型建议·规则审批）",
    description:
      "建议切换 thinking 档位（low/medium/high）。程序会做防抖死区与压力方向审批：死区内或与当前上下文压力冲突时会拒绝；通过后强制记账 level-change(source=model)。默认由程序自动切档，本工具供模型在需要更强/更省推理时主动申请升降档。",
    parameters: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: LEVEL_LADDER as unknown as string[],
          description: "目标档位（low/medium/high）",
        },
        reason: {
          type: "string",
          description: "切换理由（将记入审计日志）",
        },
      },
      required: ["level", "reason"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!thinkStateRef.current && typeof (pi as any).getThinkingLevel === "function") {
        thinkStateRef.current = createState((pi as any).getThinkingLevel());
      }
      if (!thinkStateRef.current || typeof (pi as any).setThinkingLevel !== "function") {
        return {
          content: [{ type: "text", text: "档位状态未就绪或内核不支持 setThinkingLevel。" }],
          isError: true,
          details: null,
        };
      }
      const level = params?.level as string | undefined;
      const reason = typeof params?.reason === "string" ? params.reason : "";
      if (!level) {
        return {
          content: [{ type: "text", text: "缺少 level 参数（low/medium/high）" }],
          isError: true,
          details: null,
        };
      }
      const r = proposeThinkingLevel(thinkStateRef.current, level, reason, (l) => (pi as any).setThinkingLevel(l));
      return {
        content: [{ type: "text", text: r.message }],
        isError: !r.ok,
        details: null,
      };
    },
  });

  // 工具分层管理命令
  pi.registerCommand("tools", {
    description: "工具分层：list 查看分组/状态，enable <group> 启用休眠组（见 /tools help）",
    getArgumentCompletions: (prefix) => {
      const first = (prefix?.trim().split(/\s+/)[0] ?? "").toLowerCase();
      const items = [
        { value: "list", label: "list", description: "查看分组/状态" },
        { value: "enable ", label: "enable", description: "启用休眠组（browser/admin/autopilot/link）" },
        { value: "help", label: "help", description: "显示用法" },
      ];
      if (!prefix?.includes(" ")) {
        return items.filter((i) => i.value.startsWith(first));
      }
      if (first === "enable") {
        const { SLEEPING_GROUPS } = require("./tool-groups.ts");
        return SLEEPING_GROUPS.filter((g: any) => g.name.startsWith(prefix.trim().split(/\s+/)[1] ?? "")).map((g: any) => ({
          value: "enable " + g.name,
          label: g.name,
          description: g.tools.join(", "),
        }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.trim().split(/\s+/);
      if (cmd === "enable" && rest[0]) {
        const { SLEEPING_GROUPS } = require("./tool-groups.ts");
        const g = SLEEPING_GROUPS.find((x: any) => x.name === rest[0]);
        if (!g) {
          ctx.ui.notify(`未知组: ${rest[0]}。可用: ${SLEEPING_GROUPS.map((x: any) => x.name).join(", ")}`, "warning");
          return;
        }
        enabledGroups.add(g.name);
        applyToolLayering(pi as any);
        recordToolEnable(g.name, "cmd");
        ctx.ui.notify(`已启用工具组 ${g.name}（${g.tools.join(", ")}），本会话内保持。`, "info");
        return;
      }
      const content = buildToolsReport(() => (pi as any).getActiveTools());
      const { SLEEPING_GROUPS, CORE_TOOLS } = require("./tool-groups.ts");
      ctx.ui.notify(`tools: ${SLEEPING_GROUPS.length} 个休眠组，${CORE_TOOLS.length} 个核心工具`, "info");
      pi.sendMessage(
        {
          customType: "tools-report",
          content,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // 用量诊断汇总
  pi.registerCommand("usage-diag", {
    description: "显示会话 LLM 用量诊断（每轮 input/缓存/输出汇总）",
    handler: async (_args, ctx) => {
      const { formatUsageSummary, loadDiagLines } = require("../../lib/usage-diag.ts");
      const content = formatUsageSummary(loadDiagLines());
      ctx.ui.notify(
        `usage-diag: ${content.split("\n").length} 行，已发送到聊天（不进 LLM 上下文）。`,
        "info",
      );
      pi.sendMessage(
        {
          customType: "usage-diag",
          content,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
