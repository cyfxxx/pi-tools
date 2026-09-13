---
name: pi-bug-diagnosis
description: 硬 bug 与性能回退的分阶段诊断纪律。用户说"诊断""debug""反复出现""难复现""性能回退""突然变慢/报错"时触发。核心：先建紧反馈回路（红能力/确定性/快速），禁止无回路直接猜假设。
version: v1.0
更新日期: 2026-09-12
---

# pi-bug-diagnosis 技能

硬 bug 诊断纪律。仅在明确论证时才能跳过阶段（如：回路无法构建时按"无法建回路"分支处理，而不是跳去猜）。

## 文档结构

- [README.md](README.md) — 概述、工作流与约定
- [PHASES.md](PHASES.md) — 诊断阶段详细说明
