# pi-context

上下文管理扩展：8 个事件处理器 + 1 个诊断命令，减少不必要 token 消耗，全程零用户感知。

## Handler 清单

| # | Hook | 作用 | 省 token |
|---|------|------|----------|
| 1 | `context` | 过滤 usage-diag 诊断消息（仅展示、不进 LLM 上下文）+ 工具输出分层擦除 + 只保留最新一份 compactionSummary + thinking 按 token 预算剪枝 | 数千/turn |
| 2 | `tool_result` | 工具输出>5KB（bash/read）/>20KB（其他）截断：内容路由三阶段——①JSON 结构压缩（合法 JSON 二分收缩，保前段+截断标记）②错误脱水（有 Error/Traceback 标记才激活：折叠连续重复行+截断超长行，降到 cap 内则免截断）③通用截断（bash 保留尾部、read 保留头部）。全部确定性变换（同输入必同输出），写时不改写历史 | 50-80% 工具结果 |
| 3 | `tool_result` | 缓存命中统计（聚合 cacheRead/cacheWrite，仅记录，不注入上下文） | — |
| 4 | `turn_end` | 每轮用量记录（input/缓存/输出，写入 usage-diag 日志） | — |
| 5 | `agent_settled` | 按窗口比例自动压缩判定 + `ctx.compact()`（判定放 run 完全 settled 后——agent_end 时内核可能重试/续跑，compact 会 abort 杀掉重试轮；agent_settled 语义为无重试/压缩/排队续跑） | 大窗口会话持续膨胀 |
| 6 | `session_compact` | 压缩完成后自动继续（AutoContinueGate，注入继续指令并 triggerTurn 启动新一轮） | 免手动继续 |
| 7 | `session_start` | 会话恢复时立即检查压缩阈值（resume 大会话避免首轮全量重发浪费） | 首轮全量重发 |
| 8 | `before_agent_start` | 注入主动委托建议（delegationAdvice）+ 档位化压力提示 + 执行效率指令（EFFICIENCY_ADVICE） | 上下文利用率 |

## 命令

| 命令 | 说明 |
|------|------|
| `/usage-diag` | 显示会话 LLM 用量诊断：每轮 input/缓存/输出汇总 + prune 擦除量 + 压缩触发记录（数据存 `~/.pi/agent/.usage-diag.jsonl`，仅展示不进 LLM 上下文） |
| `/tools` | 工具分层管理：`/tools list` 查看核心/休眠组状态；`/tools enable <group>` 手动启用休眠组（同 enable_tool） |

## 工具分层与按需加载（2026-08-18）

**动机**：45 个扩展工具的全量 schema 每轮注入约 5K token（首轮全价 + 每轮 cacheRead），且随功能增加线性增长。

**机制**（`tool-groups.ts`）：
- **核心常驻 29 个**：内置 7 + todo/plan 3 + subagent + ctx 4 + memory 5 + web 3 + tmux 6——schema 每轮完整注入
- **休眠 4 组 23 个**：`browser`（8）/ `admin`（8）/ `autopilot`（含 schedule_task，5）/ `link`（2）——schema 不注入，system prompt 保留 1 行简介
- **启用**：模型调用 `enable_tool("<组名>")` 或 `/tools enable <组名>` → `setActiveTools(全部 − 未启用休眠组)` → 本会话内保持；`/tools list` 查看状态
- **未知工具自动保留**：`computeActiveTools` 用 `getAllTools()` 全集减去休眠组——未来新扩展的工具默认进核心，无需维护名单

**缓存影响（重要）**：
- 工具列表变化 = 请求前缀变化 = DeepSeek 前缀缓存断裂一次（全量重发 + 重建）。启用是低频显式操作（每会话 0-2 次），**禁止实现任何“每轮动态启停”**（每轮断缓存，得不偿失）
- **启用事件台账**（2026-08-19）：每次 `enable_tool`/`/tools enable` 写一条 `{ts, group, via}` 到 `agent/stats/tool-events.jsonl`（`lib/usage-diag.ts` `recordToolEnable`）。用途：`scripts/usage-stats.mjs` 在 A 类断裂（前缀全段重放）时按 ts ±2min 关联——有事件则归因工具 schema，无事件则排除工具侧。仅数据文件、不进注入路径（缓存友好），失败静默不影响启用功能。
- 长会话后阶段（如 200K）断一次 ≈ 5-10 轮命中成本（命中 1/5 折价 vs 全价重发），可控但应避免频繁启停；工具持续增长时核心组大小封顶，成本不随工具数线性增长
- system prompt 的休眠组简介**静态**（不随启用状态变化）——启用前前缀完全稳定，启用轮仅 tools 数组变一次

**故障定位指南**：
- 工具“不见了”（`browser_navigate` 等调用报 unknown tool）→ `/tools list` 查状态；默认休眠属预期行为，用 enable_tool 启用
- 启用后仍不可用 → 检查 `layeringApplied` 逻辑：分层在首个 `before_agent_start` 应用（此时全部扩展已注册）；若扩展加载顺序异常（工具在 pi-context 之后注册）会漏——重启 pi 后重新评估
- 重启后工具恢复休眠 → 预期行为（启用状态为进程内存态，未持久化）；如需常驻把工具移入 `CORE_TOOLS`
- 缓存命中率异常下降 → 检查是否在会话中反复 enable/disable（只允许单向启用，无 disable）；usage-diag 看 cacheRead 占比
- 类型注：`getAllTools`/`getActiveTools` 未声明于官方 d.ts（plan-mode 同用法），pi-context 用类型断言访问；内核在 agent-session.js 提供

## 关键机制

- **自动压缩**：按窗口比例触发（>256K 窗口 80% 对齐 dsh thresholdRatio 0.8 / ≤256K 窗口 85%，见 `lib/auto-compact.ts`；可经 `PI_CONTEXT_COMPACT_LARGE_RATIO`/`PI_CONTEXT_COMPACT_SMALL_RATIO`/`PI_CONTEXT_WINDOW_FALLBACK` 覆盖）；判定在 `agent_settled`（`ctx.compact()` 会 abort 当前 agent 且不 await 完成；agent_end 时内核可能仍重试，agent_settled 语义为 run 完全 settled 无重试/排队续跑），`recordAutoCompact`/`markCompact` 移入 `onComplete`——压缩成功后才记账/起 180s 冷却，失败不进入 cooldown、下一轮可重试；压缩完成由 `session_compact` 事件通知；`AutoContinueGate` 在压缩完成后自动注入继续指令（`triggerTurn: true` 启动新一轮），180s 冷却防递归。resume 恢复大会话时 `session_start` 立即压缩（此时无 agent 运行，abort 是 no-op，且 gate 未 arm 不会自动继续）。重启/恢复判定另行按 `PI_CONTEXT_RESTART_RATIO`（默认 0.4=40%）——见本文档“重启/恢复压缩阈值 40%”节。
- **分层擦除**（`lib/prune.ts`）：最近 2 轮 + **120K** token 保护带内保留（`PRUNE_PROTECT_TOKENS`，2026-08-15 从 40K → 80K，2026-08-18 再 → 120K），更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构）；预计回收 **≥80K** 才应用（`PRUNE_MINIMUM_TOKENS`，20K→50K→80K）；判定确定性、擦除点单调后移。**缓存冲突警告**：擦除动作本身改变消息序列（工具输出 → 占位），擦除轮发送的序列 ≠ 上一轮 → DeepSeek 前缀缓存从擦除点断裂全量重发。旧参数（40K/20K）下实测每轮擦除触发轮新增 40-60K、长会话 250K+ 时重发 200K+，日浪费 ~4.7M tokens；调高后实测零擦除断裂轮。
  - **append-only 原则（2026-08-18 对齐 Reasonix/Orca 99%+ 命中实践）**：缓存高命中的根子是"不动老消息"——任何事后修改历史（擦除/剪枝/过滤）都会破坏前缀，此类机制只作底线保障：120K/80K 阈值下 1M 窗口（compact 阈值 40%=400K）内普通会话全程不触发，清理职责让给 auto-compact（一次性断裂）。
  - **B 方案（预留，未启用）：擦除时机后移**——完全禁用事后擦除（依赖 auto-compact），或仅在 `session_compact` 后执行一次擦除。代价：旧工具输出全保留 → 上下文膨胀更快 → compact 更频繁（每次 compact = 一次性大断裂 + 摘要 LLM 成本）+ 每轮 cacheRead 体积更大（命中 token 也计费）。净收益只在极长会话 + 极高工具输出密度时体现。**启用条件（观察指标）**：①上下文 >300K（1M 窗口 75%+）且工具输出密集时再次出现周期性断裂轮（每 N 轮一次、新增≈上下文一半、命中 20-50%）；②`scripts/usage-stats.mjs` 当前会话断裂浪费 >1M tokens 或命中率 <85%；③单日擦除断裂浪费 >1M tokens。实现位置：`lib/prune.ts` 调用点（pi-context index.ts context 事件）。
- **自动压缩（三重门限，2026-08-24 用户策略修订）**：**上下文 >256K（绝对阈值，`PI_CONTEXT_ABSOLUTE_TOKENS` 覆盖，≤0 退回窗口比例）且 任务已完成/阶段性完成（plan-mode 最新 plan.md 无 `- [~]`，`PI_CONTEXT_TASK_GATE=off` 可关）且 本会话无后台任务（pi-tmux registry 中 owner=本会话 `PI_SESSION_ID` 的 tmux 会话全部退出；tmux 缺失宽容放行；`PI_CONTEXT_TMUX_REGISTRY` 测试注入）且 任务完成后/最后操作后连续 10 分钟无用户操作（`PI_CONTEXT_IDLE_MS`；有→无任务切换打点）** —— 全部满足才自动压缩（见 `lib/auto-compact.ts` + `index.ts` 门限）；判定在 `agent_settled`（`ctx.compact()` 会 abort 当前 agent 且不 await 完成；agent_end 时内核可能仍重试，agent_settled 语义为 run 完全 settled 无重试/排队续跑），`recordAutoCompact`/`markCompact` 移入 `onComplete`——压缩成功后才记账/起 180s 冷却，失败不进入 cooldown、下一轮可重试；压缩完成由 `session_compact` 事件通知；`AutoContinueGate` 在压缩完成后自动注入继续指令（`triggerTurn: true` 启动新一轮），180s 冷却防递归。溢出兜底（tokens ≥ window）无条件强制压缩。
  - **重启/恢复压缩阈值 100K（2026-08-22 用户追加）**：看门狗 3 小时自动重启后首轮必然全量重发且未命中按全价——`session_start`（resume/reload）按 `PI_CONTEXT_RESTART_TOKENS`（默认 **100K**）判定，>100K 即提前压缩（常规 agent_settled 仍走 256K 三重门；门限同样适用）；全新会话 tokens 极小不会误触发；不与日常 decider 共用 cooldown（各自独立）。
  - **重启/恢复压缩阈值 100K（2026-08-22 用户追加）**：`session_start` 不再复用窗口 0.8/`PI_CONTEXT_RESTART_RATIO`（该环境变量已移除）——重启/恢复后首轮必然全量重发（实测断链轮重发 40-105K 按全价计费），>100K 先压比等常规 256K 再压少烧一轮全量；全新会话 tokens 极小不会误触发；不与日常 decider 共用 cooldown（各自独立）。看门狗 `maxIdleMinutes=180`（3 小时）触发重启后即走此路径。footer 状态栏同阈值：上下文 >40% 窗口追加 `⚠` 提示重启前先 /compact（patch-footer-restart-hint.mjs）。
  - **上下文解析 fallback**（2026-08-17）：内核不提供 contextWindow 时（opencode-go provider，`getContextUsage()` 返回 undefined——曾致自动压缩静默失效），回退到最近 turn_end 的 provider contextTokens + `PI_CONTEXT_WINDOW_FALLBACK`（默认 1M）+ `PI_CONTEXT_COMPACT_*` 比例，保证任意 provider 下自动压缩可用
  - **溢出兜底**（对齐 dsh CONTEXT_WINDOW_EXCEEDED）：tokens ≥ window 时绕过阈值/冷却强制压缩，比等内核在窗口-reserve 处兜底更早介入
- **分层擦除**（`lib/prune.ts`）：最近 2 轮 + **120K** token 保护带内保留（`PRUNE_PROTECT_TOKENS`，2026-08-15 从 40K → 80K，2026-08-18 再 → 120K），更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构）；预计回收 **≥80K** 才应用（`PRUNE_MINIMUM_TOKENS`，20K→50K→80K）；判定确定性、擦除点单调后移。**缓存冲突警告**：擦除动作本身改变消息序列（工具输出 → 占位），擦除轮发送的序列 ≠ 上一轮 → DeepSeek 前缀缓存从擦除点断裂全量重发。旧参数（40K/20K）下实测每轮擦除触发轮新增 40-60K、长会话 250K+ 时重发 200K+，日浪费 ~4.7M tokens；调高后实测零擦除断裂轮。
  - **append-only 原则（2026-08-18 对齐 Reasonix/Orca 99%+ 命中实践）**：缓存高命中的根子是"不动老消息"——任何事后修改历史（擦除/剪枝/过滤）都会破坏前缀，此类机制只作底线保障：120K/80K 阈值下 1M 窗口（compact 阈值 40%=400K）内普通会话全程不触发，清理职责让给 auto-compact（一次性断裂）。
  - **B 方案（预留，未启用）：擦除时机后移**——完全禁用事后擦除（依赖 auto-compact），或仅在 `session_compact` 后执行一次擦除。代价：旧工具输出全保留 → 上下文膨胀更快 → compact 更频繁（每次 compact = 一次性大断裂 + 摘要 LLM 成本）+ 每轮 cacheRead 体积更大（命中 token 也计费）。净收益只在极长会话 + 极高工具输出密度时体现。**启用条件（观察指标）**：①上下文 >300K（1M 窗口 75%+）且工具输出密集时再次出现周期性断裂轮（每 N 轮一次、新增≈上下文一半、命中 20-50%）；②`scripts/usage-stats.mjs` 当前会话断裂浪费 >1M tokens 或命中率 <85%；③单日擦除断裂浪费 >1M tokens。实现位置：`lib/prune.ts` 调用点（pi-context index.ts context 事件）。
- **thinking 剪枝**（token 预算规则）：保留最近 64K token 的 thinking（`DEFAULT_KEEP_THINKING_TOKENS = 64000`），预算耗尽处及更早的全部删除。早期"保留最近 2 轮"的数量规则已废弃——max 推理级别下单轮 reasoning 可达 5-10K，轮数上限不可控。
  - **2026-08-18 实测调高 16K→64K**：16K 预算下剪枝触发率 70%（max 推理级别每 2-3 轮超预算），每次触发修改早期消息序列 → 前缀缓存从删除点断裂全价重发（3.8h 会话 27 次断裂、1.46M token 浪费 ≈ 9.2M/天，总累计命中率被拉到 88%）。64K 覆盖典型会话全部 thinking（实测 52K）→ 剪枝休眠；仅超长深推理会话触发，触发间隔 = 64K/每轮 thinking ≈ 12-30 轮。代价：thinking 全保留使每轮 cacheRead 多 ~52K × 1/5 折价 ≈ 10K/轮等价值，远低于断裂重发成本。
- **工具输出截断**（R4）：写入时截断——bash/read 5KB（bash 用 `truncateTail` 保留尾部错误/结果，read 用 `truncateHead` 保留开头，并保留原始 details），其他工具 20KB 兜底（防止未来新工具输出失控直达上下文）。
- **执行效率注入**（`EFFICIENCY_ADVICE`，静态缓存友好）：要求模型一轮内批量发出独立工具调用（内核已支持 parallel batch）、非终轮不写解释文本、todo/plan 摘要请求时例外。
- **压力提示按档位**：基于 auto-compact 阈值比例注入固定文案（阈值内 <75% 不注入、≥75% 注入委托建议文案、≥90% 注入保存决策文案）；档位跳变才改变 system prompt，无压力时与 pi 原生完全一致 → 消息历史缓存前缀稳定。
- **真实用量校准（2026-08 审计）**：`before_agent_start` 用 `ctx.getContextUsage()` 的真实 tokens 调 `setUsedTokens` 覆盖共享库上报值（recordToolUsage 只统计工具输出，与真实上下文用量口径不一致）——plan-mode 等共享 context-budget 的消费者压力提示随之准确
- **缓存友好**：所有变换均为确定性（判定只依赖消息内容）；system prompt 注入不含时间戳与精确数值。**注意：确定性 ≠ 缓存安全**——任何变换（擦除/剪枝/过滤）只要改变消息序列就会破坏前缀缓存，确定性只保证同输入同输出，不保证与上一轮序列一致。
- **compactionSummary 去重**（R2）：context 阶段只保留最新一份，省 500-1500 token/turn。
- **压缩可逆快照（2.6）**：auto-compact 触发前把当前消息全文落盘 `logs/compact-snapshots/compact-<ts>.json`（保留 8 个/7 天，`snapshotBeforeCompact`，失败静默）。压缩属不可逆改写早期消息的 A 类断裂主因，快照使其可追溯、可对照 A 类断裂归因。纯落盘、不进注入/上下文（零缓存影响）。
- **工具用量账单（2.5→3.0，2026-08-24 重构）**：`tool_result` 钩子**无条件**调 `recordToolCall` 写跨设备事件日志（不再依赖 provider per-call usage——deepseek-flash 缺失时旧版账单长期为空）。详`memory/stats/tool-use-<device>.jsonl`（每设备一文件，Git 按文件合并无冲突；eid=`device:pid:seq` 全局唯一；带 ts/iso 时间戳；outputTokens 用 `estimateTokens` 兜底）。`agent_settled` 节流（≥60s）重算聚合 `stats/tool-usage.json`（含 firstTs/lastTs + byDevice 分桶）并清理本机 30 天前事件。**跨设备同步**：git pull 触发 `scripts/install-tool-sync-hooks.sh` 安装的 post-merge hook → `scripts/tool-stats-sync.mjs` 合并全部设备事件 + 重算；push 侧由 `pi-backup sync` 的 `git add -A` 自动带上本机事件文件（memory/stats/ 入库共享，聚合 tool-usage.json 仍 gitignored 本地重算）。查看：`node scripts/tool-stats-sync.mjs`（跨设备报告）、`usage-stats.mjs --tools`（top20 账单）。仅数据文件、不进注入路径（缓存友好）。
- **分层擦除记账（2.5）**：`recordPrune` 支持 `prune-think` 类型（thinking 剪枝记账，补 A 类断裂归因盲点），`formatUsageSummary` 已计入。
- **思考量记账（2.7，task #14/25 量化档位）**：provider 不返回 reasoning，`thinking-meter` 在 context 阶段统计上下文内 assistant thinking 块 token 总量（`estimateTokens`）逐轮落盘；`node scripts/usage-stats.mjs --thinking` 按会话聚合 thinking 总量/每轮均值，直接对照 thinking 档位（max→high）思考量变化。仅数据文件、不进注入路径。
- **thinking 档位自适应（task #25）**：`thinking-level.ts` 在 `agent_settled` 按真实 tokens/window 比例驱动 `setThinkingLevel` 升降档（critical≥95% 连 2 次降档、low<70% 连 3 次升回至基准、90s 防抖死区，阶梯 low/medium/high）。不用 context-budget 压力接口（其 used 单调不回退→升回永不触发，改用真实比例）。每次切换强制 `recordLevelChange` 落盘（`usage-stats.mjs --levels` 审计），切换后思考量由 thinking-meter 关联。档位属运行时设置不进注入面→不额外破坏缓存；副作用：内核 setThinkingLevel 实际变化会持久化 settings.defaultThinkingLevel。
- **任务完成即时记录（task #26）**：`agent_settled` 确定性写结构化任务记录到 `logs/task-records.jsonl`（用户请求摘要/用量/工具数/是否压缩/是否切档），零 LLM；批量总结层 `scripts/task-summarizer.mjs` 按游标聚合新任务 → spawn 隔离 pi 后台总结 → memory_store 沉淀经验 + 有价值的可复现长任务写 `packs/drafts/` 草稿（packs 为统一外部技能仓库，功能 3，不入 agent/skills/ 防提示词膨胀）。后台总结 pi 经 `PI_DISABLE_TASK_RECORD=1` 抑制自身记录防递归。已接入 daily-health 3.5.5 步每日自动触发。

## 注意

- 扩展的异步回调不得使用捕获的 ctx（session 替换后 stale ctx 抛错），需先取值。
- 压缩失败不致命：pi 内置窗口 − reserveTokens 兜底仍在（对 1M 窗口模型约 96.7 万，故本扩展的按比例阈值必不可少）。
