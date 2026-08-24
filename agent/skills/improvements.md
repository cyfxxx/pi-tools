
## 2026-08-24 全项目体检（pi-full-audit v1.9）
- [证据] 技能正文「误报判别清单」写 `references/ERROR-CHECKLIST.md`，未注明完整路径——实际在 `agent/skills/pi-full-audit/references/`，先在 pi-code-review/references/ 下找耗一轮。应在正文首次引用处给完整相对路径。
- [证据] 运行检查第 1 条用 admin_status/autopilot_status 工具（休眠组）——但在检查系统 prompt/缓存前缀的场景下 enable_tool 会改变工具列表、污染要测的命中率；本次改用只读文件 + usage-stats 等价完成。建议运行检查章节注明「检查缓存时勿启用休眠工具组」。
- [证据] 第 5 步终审只读代码 + 复核已足够，本次所有 HIGH/MEDIUM 判定与复核一致，无需改动分级流程。
