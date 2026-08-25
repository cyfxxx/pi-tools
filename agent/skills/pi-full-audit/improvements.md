# 未合并改进（合并见 docs/SKILLS-MAINTENANCE.md）

> 格式：`日期 | 触发任务 | 偏差/发现 | 建议改动`（证据导向：命令/路径/现象）

## 2026-08-24 全项目体检（pi-full-audit v1.9）
- [证据] 技能正文「误报判别清单」写 `references/ERROR-CHECKLIST.md`，未注明完整路径——实际在 `agent/skills/pi-full-audit/references/`，先在 pi-code-review/references/ 下找耗一轮。应在正文首次引用处给完整相对路径。
- [证据] 运行检查第 1 条用 admin_status/autopilot_status 工具（休眠组）——但在检查系统 prompt/缓存前缀的场景下 enable_tool 会改变工具列表、污染要测的命中率；本次改用只读文件 + usage-stats 等价完成。建议运行检查章节注明「检查缓存时勿启用休眠工具组」。
- [证据] 第 5 步终审只读代码 + 复核已足够，本次所有 HIGH/MEDIUM 判定与复核一致，无需改动分级流程。

# 已合并（保留最近 3 条）

- （空）

## 2026-08-25 全项目审计 + 修复闭环
- [证据] 第 6 步修复闭环未预警「多会话并行同仓」场景：本次远端中途出现 3 个外部提交 + 工作区存在并行会话进行中改动（types.ts/pi-cron.sh/.gitignore），首个提交混入 staged memory 文件导致 rebase 冲突。建议第 6 步提交前增加「检查 staged 区残留 + pull --rebase 前确认工作区归属」步骤。
- [证据] 复核子代理对 HIGH 条目的描述修正（NORMAL_MODE_TOOLS 实为 12 项）说明审查 prompt 应要求 scout 对「工具/文件清单类断言」先 cat 实际定义再写结论，减少复核修正成本。
- [证据] worker 分组按文件边界执行良好（无冲突），但 worker 新建测试文件的 tsc 类型错误（vi.fn 泛型/vi.mocked 访问）需主会话兜底修复——worker prompt 的输出约束可加「tsc -p tsconfig.local.json 无新增报错」自检要求。
