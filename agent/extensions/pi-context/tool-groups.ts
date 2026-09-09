// ── 工具分层与按需加载（2026-09-09 优化） ──
// 背景：66 个扩展工具的全量 schema 每轮注入（~13K token），工具增长成本线性。
// 方案：核心工具完整 schema 常驻；休眠工具组（browser-core/browser-full/admin/autopilot/verify/link）
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
//
// 2026-09-09 优化说明：
// - 将 14 个未分组工具移入正确的休眠组（browser-wait_for/network/find 保留核心）
// - 拆分 browser 组为 browser-core（高频）和 browser-full（低频）
// - 新增 verify 组（验证器开发工具）
// - 从未使用的核心工具分析：ctx_note/ctx_list/tmux_send/memory_stats 功能独特保留
// - ask_user 加入核心常驻（用户交互是核心能力）

export interface ToolGroup {
  name: string
  /** 1 行简介（注入 system prompt 与 /tools list 展示） */
  description: string
  tools: string[]
}

/** 核心常驻工具（schema 每轮完整注入，约 21 工具） */
export const CORE_TOOLS: string[] = [
  // 内置（文件操作核心，7 工具）
  'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
  // plan-mode（规划核心：todo 是任务追踪入口，plan_exit 是退出规划模式必需）
  'todo', 'plan_exit',
  // subagent（代理核心：委派任务是核心能力）
  'subagent',
  // pi-memory（精简：仅保留高频核心，其余移入 memory-advanced 休眠组）
  'memory_store', 'memory_search', 'memory_forget', 'ctx_exec',
  // pi-web-search（fetch_url 是独立 HTTP 获取，保留）
  'web_search', 'fetch_url',
  // pi-tmux（精简：仅保留核心操作，其余移入 tmux-advanced 休眠组）
  'tmux_run', 'tmux_read', 'tmux_stop',
  // admin_restart（高频单工具：重启高频且 schema 极小）
  'admin_restart',
  // ask_user（用户交互核心）
  'ask_user',
]

/** 休眠工具组（schema 不注入；enable_tool("<name>") 启用，本会话内保持） */
export const SLEEPING_GROUPS: ToolGroup[] = [
  // plan：规划扩展（1 工具），需要进入规划模式时启用
  {
    name: 'plan',
    description: '规划模式：进入只读探索模式（1 工具）',
    tools: ['plan_enter'],
  },
  // browser-core：浏览器基础操作（3 工具），按需启用节省 token
  {
    name: 'browser-core',
    description: '浏览器基础：导航/执行/点击（3 工具）',
    tools: ['browser_navigate', 'browser_evaluate', 'browser_click'],
  },
  // browser-advanced：浏览器高级操作（3 工具），需要等待/网络/Shadow DOM 时启用
  {
    name: 'browser-advanced',
    description: '浏览器高级：等待/网络请求/Shadow DOM 查找（3 工具）',
    tools: ['browser_wait_for', 'browser_network', 'browser_find'],
  },
  // browser-full：完整浏览器操作（12 工具），低频使用时启用
  {
    name: 'browser-full',
    description: '浏览器完整：截图/类型/滚动/提取/选择/对话/下载/上传/Cookie/关闭/PDF/帮助（12 工具）',
    tools: [
      'browser_screenshot', 'browser_type', 'browser_scroll', 'browser_extract',
      'browser_select_option', 'browser_dialog',
      'browser_download', 'browser_upload', 'browser_cookies', 'browser_close',
      'browser_pdf', 'browser_help',
    ],
  },
  // memory-advanced：记忆扩展工具（5 工具），需要跨会话笔记/历史查询时启用
  {
    name: 'memory-advanced',
    description: '记忆扩展：笔记存储/列表/快照/历史召回/统计（5 工具）',
    tools: ['ctx_note', 'ctx_list', 'ctx_snap', 'memory_recall', 'memory_stats'],
  },
  // tmux-advanced：Tmux 扩展工具（3 工具），需要状态查询/交互/等待时启用
  {
    name: 'tmux-advanced',
    description: 'Tmux 扩展：状态查询/发送输入/等待完成（3 工具）',
    tools: ['tmux_status', 'tmux_send', 'tmux_wait'],
  },
  // admin：Agent 管理（6 工具），admin_restart 已提升为核心常驻
  {
    name: 'admin',
    description: 'Agent 管理：状态/模型/配置/会话（6 工具；admin_restart 已提升为核心常驻）',
    tools: [
      'admin_status', 'admin_list_models', 'admin_set_model', 'admin_get_config',
      'admin_set_config', 'admin_list_sessions', 'admin_switch_session',
    ],
  },
  // autopilot：自主运行（5 工具），开发/运维时启用
  {
    name: 'autopilot',
    description: '自主运行：状态/遥测/策略/failover/定时任务（5 工具）',
    tools: [
      'autopilot_status', 'autopilot_stats', 'autopilot_policy', 'autopilot_failover',
      'schedule_task',
    ],
  },
  // verify：LLM 验证器开发工具（3 工具），仅开发/调优时启用
  {
    name: 'verify',
    description: 'LLM 验证器：统计/配置/测试（3 工具，仅开发调优时启用）',
    tools: ['verify_report', 'verify_config', 'verify_test'],
  },
  // link：多设备互联（2 工具），跨设备协作时启用
  {
    name: 'link',
    description: '多设备互联：跨设备委派/查询（2 工具）',
    tools: ['link_send', 'link_status'],
  },
  // web-fallback：降级备选搜索（1 工具），SearXNG 不可用时启用
  {
    name: 'web-fallback',
    description: '降级搜索：无 SearXNG 时的 HTTP 搜索备选（1 工具）',
    tools: ['web_fetch'],
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
