# Changelog — plan-mode

## [初始版本]

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
