// ── 工具分层与按需加载（2026-08-18） ──
// 背景：45 个扩展工具的全量 schema 每轮注入（~5K token），工具增长成本线性。
// 方案：核心工具完整 schema 常驻；休眠工具组（browser/admin/autopilot/link）
// 不注入 schema，仅在 system prompt 中保留 1 行简介，需要时由模型调用
// enable_tool("组名") 启用（本会话内保持）。
//
// 关键约束（勿违反）：
// 1. 工具 schema 是 API 请求级状态（function calling 硬约束）——模型无法
//    "读取"未注入 schema 的工具再调用；enable_tool 是唯一入口（改 setActiveTools）。
// 2. 工具列表变化 = 前缀缓存断裂（全量重发）——enable 是低频显式操作，
//    会话内保持固定；禁止任何"每轮动态启停"的实现（会每轮断缓存）。
// 3. 启用状态是进程内存态：pi 重启后恢复默认分层（休眠组回到休眠）。
// 4. 名单维护：CORE_TOOLS 之外的未知工具（未来新扩展）默认自动进入核心
//    （applyToolLayering 用 getAllTools 全集减去休眠组，不依赖名单完整性）。

export interface ToolGroup {
  name: string
  /** 1 行简介（注入 system prompt 与 /tools list 展示） */
  description: string
  tools: string[]
}

/** 核心常驻工具（schema 每轮完整注入） */
export const CORE_TOOLS: string[] = [
  // 内置
  'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
  // plan-mode
  'todo', 'plan_enter', 'plan_exit',
  // subagent
  'subagent',
  // pi-memory（ctx + memory 全系：记忆是常驻能力）
  'ctx_exec', 'ctx_note', 'ctx_list', 'ctx_snap',
  'memory_store', 'memory_search', 'memory_recall', 'memory_stats', 'memory_forget',
  // pi-web-search
  'web_search', 'fetch_url', 'web_fetch',
  // pi-tmux（后台任务高频）
  'tmux_run', 'tmux_status', 'tmux_read', 'tmux_send', 'tmux_stop', 'tmux_wait',
  // 高频单工具（2026-08-25）：admin_restart 常驻——重启高频且 schema 极小，
  // 每次 enable_tool("admin") 只为重启需多一轮交互 + 前缀缓存重算，不划算
  'admin_restart',
]

/** 休眠工具组（schema 不注入；enable_tool("<name>") 启用，本会话内保持） */
export const SLEEPING_GROUPS: ToolGroup[] = [
  {
    name: 'browser',
    description: '网页浏览/截图/点击/提取（8 工具）',
    tools: [
      'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
      'browser_scroll', 'browser_extract', 'browser_evaluate', 'browser_close',
    ],
  },
  {
    name: 'admin',
    description: 'Agent 管理：状态/模型/配置/会话（7 工具；admin_restart 已提升为核心常驻）',
    tools: [
      'admin_status', 'admin_list_models', 'admin_set_model', 'admin_get_config',
      'admin_set_config', 'admin_list_sessions', 'admin_switch_session',
    ],
  },
  {
    name: 'autopilot',
    description: '自主运行：状态/遥测/策略/failover/定时任务（5 工具）',
    tools: [
      'autopilot_status', 'autopilot_stats', 'autopilot_policy', 'autopilot_failover',
      'schedule_task',
    ],
  },
  {
    name: 'link',
    description: '多设备互联：跨设备委派/查询（2 工具）',
    tools: ['link_send', 'link_status'],
  },
]

/** 休眠组名 → 工具集合（查重用） */
export const SLEEPING_TOOL_SET: ReadonlySet<string> = new Set(
  SLEEPING_GROUPS.flatMap((g) => g.tools),
)

/** 分组完整性校验：核心与休眠无重叠（测试用） */
export function validateGroups(): { overlap: string[]; emptyGroups: string[] } {
  const coreSet = new Set(CORE_TOOLS)
  const overlap = SLEEPING_GROUPS.flatMap((g) => g.tools.filter((t) => coreSet.has(t)))
  const emptyGroups = SLEEPING_GROUPS.filter((g) => g.tools.length === 0).map((g) => g.name)
  return { overlap, emptyGroups }
}

/**
 * 休眠工具组静态简介（注入 system prompt）。
 * 缓存友好：内容只依赖组定义（不依赖启用状态）——启用后简介保持不变，
 * system prompt 前缀在启用轮之前完全稳定；启用轮仅 tools 数组变化一次。
 */
export function buildSleepingSummary(): string {
  const lines = ['## 休眠工具组（默认不注入 schema；需要时用 enable_tool("<组名>") 启用，本会话内保持，重启恢复默认）']
  for (const g of SLEEPING_GROUPS) {
    lines.push(`- ${g.name}: ${g.description}`)
  }
  lines.push('启用会使工具列表更新一次（前缀缓存重算），属低频显式操作；已启用的组再次 enable 无副作用。')
  return lines.join('\n')
}

/**
 * 计算活动工具集：全部已注册工具减去"未启用的休眠组"工具。
 * 未知工具（不在任何名单）自动保留 → 未来新扩展默认核心，无需维护名单。
 */
export function computeActiveTools(
  allToolNames: string[],
  enabledGroups: ReadonlySet<string>,
): string[] {
  const excluded = SLEEPING_GROUPS.filter((g) => !enabledGroups.has(g.name)).flatMap((g) => g.tools)
  const excludedSet = new Set(excluded)
  return allToolNames.filter((n) => !excludedSet.has(n))
}
