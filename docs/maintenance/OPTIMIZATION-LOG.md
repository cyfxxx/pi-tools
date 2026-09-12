# OPTIMIZATION-LOG

> 2026-09-11 自动化审查写入（memory-lifecycle.mjs --json 只读报告结果）。以下条目待用户确认后执行，不直接修改提示词/扩展/记忆库。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 记忆生命周期治理、优化日志 |
| 相关文档 | [VISION.md](../design/VISION.md), [SELF-OPTIMIZING-ROADMAP.md](../design/SELF-OPTIMIZING-ROADMAP.md) |

---

## 目录

- [一、升格候选](#一升格候选recurrence5待确认)
- [二、聚合候选](#二聚合候选待确认)
- [三、冲突嫌疑](#三冲突嫌疑合并裁决建议)
- [四、淘汰候选](#四淘汰候选仅列出不自动删除)
- [五、自动课程提案](#五自动课程提案)
- [六、2026-09-12 memory-lifecycle 只读报告补充](#六2026-09-12-memory-lifecycle-只读报告补充)

---

## 一、升格候选（recurrence≥5，待确认）

| 条目 | recurrence | 类别 | 建议 |
|------|-----------|------|------|
| 翻译脚本匹配技巧 | 25 | fact | 已为高频事实，可考虑升格为 procedure 并补充到 pi-translate-zh 技能的排查流程中 |
| 代码标识符不应翻译 | 25 | fact | 同上，可与上一条合并为「翻译排查清单」procedure |
| 每日知识订阅流程 | 5 | solutions | recurrence 刚达阈值，内容完整可直接升格为 procedure |

---

## 二、聚合候选（待确认）

- **组1（11 条，sumRecurrence=17）**：主题为 knowledge-fetch.py 相关（零LLM知识订阅脚本架构、标题哈希去重机制、抓取渠道清单等）。归纳方向：将多条碎片化 knowledge-fetch 知识合并为一条完整的「知识订阅脚本架构与维护指南」procedure。
- **组2（10 条，sumRecurrence=13）**：主题为 entries.json 冲突合并与管理（跨分支合并、三方比对、损坏恢复、低置信标签等）。归纳方向：合并为「entries.json 冲突管理与恢复 SOP」procedure。
- **组3（8 条，sumRecurrence=12）**：主题为 tool-stats 每日聚合提交（多条同义标题）。归纳方向：合并为「tool-stats 每日聚合提交标准流程」procedure。

---

## 三、冲突嫌疑（合并裁决建议）

1. **install-wrapper.sh readlink 解析 bug**：`8eb4073c`（solutions）与 `1acb34d8`（fact）内容重复，建议保留 solutions 条目，删除 fact 条目。
2. **.pi 配置仓库远程推送流程**：`ec94f20d` 与 `242c5064` 标题仅差一个「配置」字，内容高度相似，建议合并为一条 procedure。

---

## 四、淘汰候选（仅列出，不自动删除）

- `b2cdc41a` 用户报告 bug（content 无实义）
- `559db7cb` 用户使用 /q 命令（content 无实义）
- `0301ef42` 用户中文交流习惯（content 无实义）
- `b8539db8` 用户偏好功能健康检查（content 无实义）
- `d0530c4c` 检测到 5 项功能失败（content 无实义）
- `d7fd4241` test（content 无实义，recurrence=9）

---

## 五、自动课程提案

### 2026-09-11

| 主题 | 工单 | 状态 |
|------|------|------|
| 空壳心跳任务识别与记忆沉淀过滤 | workticket-empty-heartbeat-filter.md | proposed（新建） |
| 调度任务提示词自包含性 | — | new（无工单，连续第1天） |

### 2026-09-12

| 主题 | 工单 | 状态 |
|------|------|------|
| 空壳心跳任务识别与记忆沉淀过滤 | workticket-empty-heartbeat-filter.md | proposed（延续，已提工单） |
| 调度任务提示词自包含性 | — | new（连续第2天，仍无工单） |
| 会话清理类指令需先确认范围与目标ID | — | new（无工单，连续第1天） |

---

## 六、2026-09-12 memory-lifecycle 只读报告补充

- 升格候选 3 条：翻译脚本匹配技巧（rec=25）、代码标识符不应翻译（rec=25）、每日知识订阅流程（rec=5）——均满足 recurrence≥5，但「验证有效」需用户确认后方可写入。
- 聚合候选 3 组：组1 knowledge-fetch.py（11条/sumRec=17）、组2 entries.json 冲突管理（10条/sumRec=13）、组3 tool-stats 每日聚合（8条/sumRec=12）——均给出归纳方向草案，待用户确认。
- 冲突嫌疑 2 组：install-wrapper.sh readlink bug（保留 solutions 删 fact）、.pi 配置仓库远程推送流程（合并为一条 procedure）——待用户确认。
- 淘汰候选 6 条：仅列出，不自动删除，批量删除须用户确认。