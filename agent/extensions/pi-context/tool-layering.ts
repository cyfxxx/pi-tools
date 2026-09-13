/**
 * 工具分层模块 - 管理休眠工具组和按需加载
 */

import { CORE_TOOLS, SLEEPING_GROUPS, computeActiveTools, buildSleepingSummary } from "./tool-groups.ts";

/** 启用的工具组状态 */
export const enabledGroups = new Set<string>();

/** 应用工具分层：全部注册工具减去未启用休眠组的工具 */
export const applyToolLayering = (
  pi: { setActiveTools: (tools: string[]) => void; getAllTools: () => Array<{ name: string }> },
) => {
  const all = pi.getAllTools().map((t) => t.name);
  const active = computeActiveTools(all, enabledGroups);
  pi.setActiveTools(active);
};

/** 生成 /tools list 报告 */
export const buildToolsReport = (getActiveTools: () => string[]) => {
  const activeNames = new Set(getActiveTools());
  const lines = ["## 工具分层状态"];
  lines.push(`核心常驻（${CORE_TOOLS.length}）: ${CORE_TOOLS.join(", ")}`);
  for (const g of SLEEPING_GROUPS) {
    const state = enabledGroups.has(g.name) ? "已启用" : "休眠";
    lines.push(`- ${g.name} [${state}]（${g.tools.length}）: ${g.tools.join(", ")}`);
  }
  const inactive = activeNames.size === 0 ? "(未知)" : `${activeNames.size} 个活动`;
  lines.push(`当前活动工具: ${inactive}`);
  return lines.join("\n");
};

/** 导出 buildSleepingSummary 供外部使用 */
export { buildSleepingSummary };
