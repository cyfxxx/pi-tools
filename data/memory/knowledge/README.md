# memory/knowledge — 长文知识库

## 定位

存放日常会话中收集到的**内容较长、事实密集、不适合直接放入长期记忆（entries.json）**的知识。

分工边界：

| 去处 | 内容形态 | 原因 |
|---|---|---|
| `memory_store`（entries.json） | 结论级短条目（≤500 字） | entries.json 会进入检索注入池，条目必须短；长文会撑爆注入预算 |
| `memory/knowledge/`（本目录） | 论据级/全景级长文（参数表、config 实测、多模型对比） | 不注入上下文，需要时显式 read；入库 git 跨环境共享 |
| `docs/` 或 `memory/stats/` | 项目自身文档 / 运行时统计 | 与外部知识无关 |

约定：写入本目录的知识，若同时值得被检索命中，应同步在 entries.json 存一条**短摘要**，并在 content 末尾注明 `详情见 memory/knowledge/<文件名>`。

## 文件规范

- 命名：`YYYY-MM-<英文主题>.md`（按收集月份归档，便于时效排序）
- **必须**包含 YAML front-matter：

```yaml
---
title: 中文标题
collected: 2026-08-29        # 收集/核实日期
valid-until: 2026-11-30      # 建议复核期限（快变领域 ≤3 个月，稳定知识可写长期）
refresh-trigger: 什么事件发生时应复核（如：下一代模型发布）
source: 信息来源及可信度说明（官方渠道直查 / 二手转述）
confidence: high | medium | low
tags: [检索用标签]
---
```

- 正文只写核实过的事实；未核实信息标注"未验证"或直接不写。

## 时效性与生命周期

1. 写入时必须判断领域变化速度并给出 `valid-until`（超过期限的条目视为过期）。
2. 过期处置（三选一）：**复核更新**（重新查证后改写 front-matter 的 collected/valid-until）→ **压缩降级**（把仍然成立的结论压缩成短条目入 entries.json，删除原文）→ **删除**。
3. 处置时机：每日回顾例行任务扫描 `valid-until` 已过期条目；或下次用到该知识时顺手复核。
4. 与 VISION.md 记忆治理对齐：本目录属于"教训/知识闭环"的中间层，长期稳定有效的结论应单向压缩升格进 entries.json，避免长文无限累积。

## 条目索引

| 文件 | 主题 | collected | valid-until |
|---|---|---|---|
| `2026-08-llm-flagship-architectures.md` | 2026 开源旗舰模型架构核实（DeepSeek-V4 / Kimi-K3 / GLM-5 / Qwen3.8） | 2026-08-29 | 2026-11-30 |
