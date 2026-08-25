---
name: pi-memory
description: 自主学习记忆扩展（已合并 ctx-lite）。每轮自动注入高价值跨会话记忆到系统提示；会话结束/compaction 时自动提取新知识（决策/事实/偏好/约定/教训）入长期记忆库，Mem0 式四操作消解冲突。提供 memory_store/memory_search/memory_recall 等工具与 /memory 命令（search/stats/summary/prune/cleanup）。
---

# pi-memory 技能

跨会话持久记忆库 + 自主学习闭环。**每轮会话常驻注入** Top 高价值记忆，帮助保持上下文连续；会话结束自动提取新知识，无需手动维护。

## 自动机制（无需干预）

- 每轮会话：自动注入 ~500 token「持续记忆」块（高价值条目 + 最近会话摘要）
- compaction / 会话结束：自动提取会话中的新知识（LLM 分析 → 消解 → 入库）
- 冲突处理：同类别同标签但内容矛盾 → 新结论取代旧结论（标记 superseded）
- 幂等保护：同会话不重复提取

## 主动用法

在对话中发现值得长期记住的信息时，**主动调用** `memory_store`：
- 用户偏好/习惯（"我喜欢用 Shell 管理"）
- 项目约定（"SearXNG 端口 4000"、"CI 用 GitHub Actions"）
- 可复用流程（"恢复步骤: git pull → rebuild.sh"）
- 环境事实（"aarch64 容器"）

需要回忆历史知识时调用 `memory_search` 或 `memory_recall`（可附 summaries 查会话时间线）。

## 工具

| 工具 | 功能 |
|------|------|
| `memory_store` | 存知识（category/title/content/tags/confidence），自动去重合并 |
| `memory_search` | 检索（query/category/tags/limit），BM25 词法 + 质量分排序 |
| `memory_recall` | 综合回忆：记忆 + `summaries:true` 附带最近会话摘要 |
| `memory_stats` | 统计 |
| `memory_forget` | 删除（id 或 category+olderThan） |
| `ctx_exec` | 子进程执行代码（JS/TS/Python/Shell），仅 stdout 入上下文 |
| `ctx_note` | 持久笔记（`key@ttl=ISO时间` 可过期，value 传 null 删除） |
| `ctx_list` | 列出笔记（prefix 过滤，detail:true 显示内容） |
| `ctx_snap` | 检查点（`restore:<name>` 恢复，`list` 查看） |

### memory_store 参数
| 参数 | 必需 | 说明 |
|------|------|------|
| `category` | 是 | fact / preference / habit / procedure / reference |
| `title` | 是 | 简短标题，用作搜索索引 |
| `content` | 是 | 详细内容 |
| `tags` | 否 | 标签数组 |
| `confidence` | 否 | 置信度 0-1（默认 0.7，直接观察 0.9-1.0，推断 0.5-0.7） |

## 命令

| 命令 | 功能 |
|------|------|
| `/memory search <q> [--category=] [--limit=N]` | 搜索 |
| `/memory stats` | 统计 |
| `/memory summary [N]` | 会话摘要时间线 |
| `/memory prune` | 清理低价值记忆 |
| `/memory cleanup [--keep=N] [--dry-run]` | 清理过期笔记/检查点 |
| `/memory cleanup --all` | 清空笔记+检查点 |

## 记忆注入规则

- 注入块标记 `pi-memory-injection`，每轮刷新（不进历史累积）
- 排序：置信度×0.5 + 时效×0.25 + recurrence×0.25（提取复现次数），最多 6 条 + 2 条摘要
- 预算 `PI_MEMORY_INJECT_TOKENS`（默认 500）截断

## 数据存储

- `~/.pi/memory/entries.json`（L1 记忆）、`notes.json`（L0 笔记）、`summaries.json`（L2 摘要）、`checkpoints/`（快照）
- 上限 1 MB，超限提示 `/memory prune`
- ctx-lite 数据已自动迁移
