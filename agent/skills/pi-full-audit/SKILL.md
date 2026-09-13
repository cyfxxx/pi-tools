---
name: pi-full-audit
description: 全项目深度审计（区别于 code-review 的 diff 审查）：全量确定性检查 + 回归测试 + subagent 并行审查与复核 + 分级报告；含会话运行健康巡检（提示词注入/缓存命中/token 消耗/自动执行功能）。用户说"全面检查""深度审计""全项目审查""健康检查""体检""运行检查""会话检查""audit"时触发。不适用：仅审一次 git diff 用 pi-code-review；查询具体文件/单点问题用 grep/read。
version: v1.10
更新日期: 2026-09-12
经验基线: 见 references/EXPERIENCE-BASELINE.md
---

# pi-full-audit 全项目深度审计

对整个仓库（含扩展、脚本、技能）做一次完整审计，产出可信的分级报告。核心信条：**审查报告不可全信，建议清单必须经复核子代理逐条核实、主会话终审后才可执行**。

## 文档结构

- [README.md](README.md) — 概述、工作流与约定
- [WORKFLOW.md](WORKFLOW.md) — 详细步骤说明
- [REPORT.md](REPORT.md) — 分级报告模板
