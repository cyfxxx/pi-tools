---
name: pi-memory
description: 轻量知识库+自主学习扩展。支持跨会话持久记忆，自动在会话启动时注入 Top-5 相关记忆，提供存储/搜索/统计/删除 API。模型可在对话中自主调用 memory_store 记录新知识、调用 memory_search 检索已有知识。
---

# pi-memory 技能

跨会话持久记忆库。每次会话启动时自动注入 Top-5 高价值记忆到系统提示，帮助 LLM 保持上下文连续性。

## 命令列表

| 命令 | 功能 |
|------|------|
| `/memory:search <query> [--category=] [--limit=N]` | 搜索记忆库 |
| `/memory:stats` | 显示记忆库统计信息 |
| `/memory:prune` | 清理低价值记忆（需确认） |

## 工具

### memory_store
存储一条知识到持久记忆库。在以下场景**主动调用**：
- 发现用户的个人偏好或习惯（"我喜欢用 Shell"）
- 学到的项目配置信息（"SearXNG 端口是 4000"）
- 常用的操作流程（"恢复步骤: git pull → rebuild.sh"）
- 环境细节（"aarch64 容器"）

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `category` | string | 是 | fact / preference / habit / procedure / reference |
| `title` | string | 是 | 简短标题，用作搜索索引 |
| `content` | string | 是 | 详细内容 |
| `tags` | string[] | 否 | 标签数组 |
| `confidence` | number | 否 | 置信度 0-1（默认 0.7） |

### memory_search
搜索已存储的记忆。支持关键词、类别、标签过滤。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 搜索关键词 |
| `category` | string | 否 | 类别过滤 |
| `tags` | string[] | 否 | 标签过滤 |
| `limit` | integer | 否 | 返回条数（默认 5） |

### memory_stats
查看记忆库统计信息。

### memory_forget
删除记忆条目。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 精确删除指定 ID |
| `category` | string | 否 | 按类别批量删除（需配合 olderThan） |
| `olderThan` | string | 否 | ISO 日期，删除该日期之前的条目 |

## 使用示例

当发现新知识时（第一次使用某个功能后）:
```
memory_store({
  category: "preference",
  title: "用户偏好: 使用 Shell 管理系统",
  content: "用户倾向于使用 Shell 脚本而非 Python 进行系统管理任务...",
  tags: ["shell", "system", "preference"],
  confidence: 0.9
})
```

当需要回忆时:
```
memory_search({ query: "shell preference" })
```

## 记忆注入规则

- 会话启动后前 2 轮自动注入 Top-5 高价值记忆
- 注入的记忆按类别分组（偏好/事实/流程/...）
- 每轮对话完成后，上一轮的注入消息从上下文中过滤掉
- 特定知识可通过显式调用 memory_search 获取

## 数据存储

- 位置: `~/.pi/memory/entries.json`
- 上限: 1 MB（同 ctx-lite）
- 清理策略: `/memory:prune` 手动清理，或自动阈值触发
