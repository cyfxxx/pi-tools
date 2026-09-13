---
name: pi-code-review
description: 审查 git 变更（diff/HEAD/未跟踪）：确定性检查 + 清单核对 + HIGH/MEDIUM/LOW 分级报告。用户说"审查""评审""review""检查代码""看下这个改动""PR 审查"时触发。不适用：全项目/运行态健康检查用 pi-full-audit；纯文档改动且无逻辑变更。
version: v1.3
更新日期: 2026-09-12
参考基线: alibaba/open-code-review v1.9.3
---

# pi-code-review 代码审查

审查代码时的标准流程：**自检 → 确定性检查脚本 → 人工检查清单 → 分级报告**。

## 文档结构

- [README.md](README.md) — 概述、工作流与约定
- [CHECKLIST.md](CHECKLIST.md) — 人工检查清单
- [REPORT.md](REPORT.md) — 分级报告模板与示例
