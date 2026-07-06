# Changelog — plan-mode

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
