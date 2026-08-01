# Changelog — plan-mode

## [2.5.0] - 2026-08-01

### Added

- **blocked 阻塞状态**：`pending/in_progress → blocked`，`blocked → pending/in_progress/completed/deleted`。UI 显示 `⏸`（error 色）与"已阻塞"标签，`/todos` 新增分组，计数 total 含 blocked。存在阻塞任务时计划不会判定完成。
- **暂停/安全退出**：`/plan` 退出规划模式时保留任务与进度（原行为是清空）；新增 `/planclear` 手动清空、`/planresume` 恢复执行模式并自动注入剩余步骤上下文。
- **执行中计划修订**：执行模式下 LLM 输出新的 `Plan:` 块且用户明确要求修改时，自动用新步骤替换未完成任务（已完成保留），聊天提示"计划已修订"，下一轮注入新执行上下文。双重判断（修订意图 + Plan 头）防止问句误触发。
- **`/planview` 命令**：展示当前版本计划全文。

### Removed

- **`task` 子任务工具**：仅写 .md 文件无实际执行价值，与 subagent（worker/parallel）功能重叠。
- **`questionnaire` 工具条目**：SDK 中不存在此工具（setActiveTools 静默忽略），PLAN_MODE_TOOLS 与提示词中的死条目。
- **`Task.owner` 字段**：单用户场景无协作，从创建到展示均未使用。
- **`plan-todo-list` 冗余发送**：仅在计划有变化（needsChoice）时才展示任务列表，避免每次 agent_end 重复刷屏。

## [2.4.0] - 2026-08-01

### Fixed

- **注入消息永久累积（S1）**：`context` hook 从"仅过滤 `plan-mode-context`"升级为"每种注入类型只保留最新一条"（覆盖 `plan-execution-context`、`plan-pressure-tag`、`plan-mode-recovery`、`plan-urgency-hint`、`plan-summary-request`、`plan-skill-list`、`plan-complete`、`plan-todo-list`）。此前这些消息会作为 user 消息写入会话日志并在恢复时反复进入上下文，永久浪费 token。
- **`before_agent_start` 提前 return（S2）**：执行模式 todo 未变化时的提前返回导致 compaction 恢复/溢出预警/技能清单注入全部失效。重构为统一优先级链：plan 上下文 → 执行上下文 → 压缩恢复 → 溢出预警 → 摘要请求 → 技能清单 → 压力标签兜底。
- **中文计划提取（S3）**：`extractTodoItems` 支持「计划：/计划:」头部、中文顿号（`1、`）与全角句点（`1．`）编号、checklist 格式（`- [ ]`/`-`/`•`/`☐`）。`isPlanRevisionIntent` 增加中文修订词（修改/改为/改成/换成/调整/重新规划/删除/新增/精简等）与中文问句排除（为什么/怎么/如何/解释等）。
- **`persistState` 哈希（M4）**：QA 内容变化（条数不变）现在也会触发持久化，不再只按条数计哈希。

### Changed

- **技能清单动态化（M1）**：不再硬编码 `pi-backup`/`pi-translate-zh`，改为扫描 `~/.pi/agent/skills/*/SKILL.md` 的 frontmatter，新增技能自动生效。
- **计划质量提示（E3）**：PLAN MODE 注入提示要求结构化影响分析（影响文件/风险/未知点）与步骤粒度规范。
- **执行状态显示（E2）**：`TodoOverlay` 标题行高亮显示当前执行步骤（`▶ 步骤标题`）。
- **安全白名单（M2）**：补充 `lsblk` 到只读白名单，与 README 附录一致。

### Removed

- 删除死代码 `extractDoneSteps()` / `markCompletedSteps()` 及其冗余 import。

## [2.3.0] - 2026-07-31

### Changed

- **`execSync` 移除**：git 操作（计划版本管理、`/plandiff`、迭代计数）改用 `runGit()`（`pi.exec("bash", ["-c", ...])`），与 Pi 扩展 API 一致，不再依赖 `child_process`。
- **context 过滤简化**：只过滤 `customType === "plan-mode-context"` 的消息，移除按内容匹配 `[PLAN MODE ACTIVE]` 的用户消息过滤。
- **持久化去重**：`persistState()` 对状态内容计算哈希（tasks + 标志位 + QA 数量 + 计划目录），状态未变化时跳过 `appendEntry`，减少冗余写入。
- **compaction 恢复消息固定化**：移除对 `_ctx.last_user_msg` / `_ctx.pending_tasks` 的死读取（从未被写入），恢复提示改为固定文案。
- **agent_end 迭代计数**：通过 `git rev-list --count HEAD` 统计计划迭代版本，替代依赖状态推断。

### Removed

- 移除 `checkMissedTasks()` 死方法。

## [2.2.0] - 2026-07-07

### Added

- **Compaction 恢复提示（P1）**：检测到刚完成 compaction 时，在 `before_agent_start` 注入"上下文已压缩，继续之前的工作"提示，解决压缩后断片问题。
- **语义摘要引导（P2）**：压力达到 critical 时，注入引导指令，让 LLM 用 ctx_note 保存结构化摘要后再 `\`/compact\``。
- **溢出预警（P3）**：引入 `getUrgencyHint()`，在剩余 token 不足 20K/10K 时注入溢出预警，让 LLM 主动应对。

## [2.1.0] - 2026-07-07

### Added

- **`task` 工具**：创建独立子任务描述文件到 `~/.pi/tasks/`，支持并行探索任务。
- **技能清单注入**：`before_agent_start` 事件中自动告知 LLM 可用技能（`/skill:pi-backup`、`/skill:pi-translate-zh`），仅首次会话注入一次。

### Changed

- **工具集精简**：`find` + `ls` → `glob`，减少工具数量，glob 覆盖两组功能。
- **任务完成方式统一**：移除 `[DONE:n]` 标记处理，所有任务状态变更通过 `todo` 工具完成。
- **执行上下文提示更新**：`plan-execution-context` 消息中指导 LLM 使用 `todo update status=completed` 而非 `[DONE:n]`。
- **Session resume 简化**：不再扫描历史消息中的 `[DONE:n]` 标记，直接从待办列表恢复状态。
- **`todo` 工具 promptGuidelines 精简**：从 5 条减至 3 条，节省 ~300 token。

### Removed

- 移除 `[DONE:n]` 标记的扫描和解析逻辑（`markCompletedSteps`、`extractDoneSteps`）。
- 移除 `find`、`ls` 工具引用。
- 移除旧式 session resume 的消息重扫描逻辑。

## [2.0.0] - 2026-07-06

### Added

- **`todo` 工具**：合并自 rpiv-todo，支持 6 个操作（create/update/list/get/delete/clear），4 状态机（pending → in_progress → completed → deleted）
- **TodoOverlay 悬浮层**：编辑器上方显示任务列表，彩色图标（○/◐/✓）、删除线、溢出折叠
- **`/todos` 命令升级**：按状态分组显示（待办/进行中/已完成），带彩色图标和数量统计
- 计划模式三个选项已中文化："执行计划（追踪进度）"、"继续计划模式"、"优化计划"

### Changed

- 底层任务存储从 `TodoItem[]` 数组升级为 `TaskState`（带 reducer 的正交状态管理）
- `[DONE:n]` 标记现在通过 reducer 更新任务状态，保持与 `todo` 工具的状态一致
- `extractTodoItems` 返回 `Task[]` 类型，通过 reducer 创建任务
- 系统提示词和用户界面文字全部中文化

### Removed

- 移除对 `@juicesharp/rpiv-config`、`typebox`、`@juicesharp/rpiv-i18n` 的依赖
- 移除 blockedBy 依赖追踪（保持简洁，后续可按需恢复）
- 移除旧 `TodoItem` 接口（由 `Task` 替代）

## [1.0.0] - 初始版本

### Added
- `/plan` 命令 + 键盘快捷键 Ctrl+Alt+P，切换只读规划模式
- `--plan` CLI 标志，启动时直接进入规划模式
- Bash 受限允许列表：仅允许 read-only 命令（cat/grep/ls/git status 等）
- 自动从 `Plan:` 段落提取编号步骤
- `[DONE:n]` 标记显式完成步骤
- 执行进度组件（completed/total）
- `/todos` 命令：显示当前计划待办
- 执行前要求 LLM 先提澄清问题再创建计划
- 执行前要求 LLM 识别受影响文件、风险和边界情况（影响分析）
- 防止普通追问意外覆盖已有计划
- 计划版本管理：每次保存到 `~/.pi/plans/plan-<timestamp>/plan.md`，自带 git 仓库
- `/plandiff` 命令：查看前后两次计划的差异
- `/planqa` 命令：查看计划讨论的问答历史
- 会话恢复后状态完全复原（计划模式/待办/执行状态/计划目录/问答历史）
- 恢复时从历史消息重建已完成步骤列表
