# knowledge-fetch — 零 LLM 知识订阅搭建

以官方 API + RSS 直连替代搜索引擎，为 pi 定时任务提供稳定、真实的信息抓取。

- **入口**：`SKILL.md`（诊断/渠道调研/抓取实现/调度接入/迭代五步流程）
- **已验证实例**：`/root/.pi/scripts/knowledge-fetch.py` v2（5 大 section，接入 daily-health-check 任务，2026-08 实测）
- **环境备注**：termux-ubuntu（proot-Distro aarch64）；本机脚本可直接复用，定时接入走 pi-autopilot scheduled-tasks.json
- **维护**：使用后偏差按仓库级 `docs/SKILLS-MAINTENANCE.md` 机制沉淀，经验追加 `EXPERIENCE.md`
