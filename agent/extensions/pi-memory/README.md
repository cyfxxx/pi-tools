# pi-memory 扩展

> 轻量知识库 + 自主学习扩展 — 跨会话持久记忆，让 LLM 不再失忆

---

## 目录

- [一、设计理念](#一设计理念)
- [二、架构概览](#二架构概览)
- [三、4 个 LLM 工具详解](#三4-个-llm-工具详解)
  - [memory_store](#1-memory_store--存储知识)
  - [memory_search](#2-memory_search--搜索记忆)
  - [memory_stats](#3-memory_stats--记忆统计)
  - [memory_forget](#4-memory_forget--删除记忆)
- [四、3 个斜杠命令](#四3-个斜杠命令)
- [五、生命周期事件](#五生命周期事件)
- [六、记忆注入策略](#六记忆注入策略)
- [七、数据存储](#七数据存储)
- [八、使用场景](#八使用场景)
- [九、兼容性](#九兼容性)
- [十、测试](#十测试)
- [十一、常见问题](#十一常见问题)

---

## 一、设计理念

Pi 的现有扩展形成了一个完整的工具链：

- `pi-web-toolkit` 获取外部信息
- `pi-scheduler` 定时执行任务
- `subagent` 委托子代理
- `plan-mode` 工作流规划

但缺少一块：**信息只能活在当前会话中**。用户偏好、项目约定、环境配置、API 用法——每次新会话都要重新问或重新搜。

pi-memory 填补这个缺口：提供一个**结构化的、可搜索的、跨会话持久化的知识库**，让 LLM 在会话启动时自动获得上下文，并在对话中自主记录新知识。

核心设计原则：
- **轻量** — 800 行 TypeScript，零外部依赖（仅 Node.js 内置 API）
- **结构化** — 按类别（事实/偏好/习惯/流程/参考）管理知识，支持标签和置信度
- **自动注入** — 会话前 2 轮自动注入 Top-5 高价值记忆，后续按需搜索
- **自我维护** — Jaccard 去重防止重复条目，冷数据淘汰避免膨胀

---

## 二、架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                    pi-memory 扩展 (index.ts)                      │
│                                                                   │
│  ┌────────────────────────┐   ┌──────────────────────────────┐   │
│  │  4 个 LLM 工具          │   │  3 个斜杠命令                 │   │
│  │                         │   │                              │   │
│  │  memory_store           │   │  /memory:search              │   │
│  │  memory_search          │   │  /memory:stats               │   │
│  │  memory_stats           │   │  /memory:prune               │   │
│  │  memory_forget          │   │                              │   │
│  └────────┬───────────────┘   └──────────┬───────────────────┘   │
│           │                              │                        │
│           ▼                              ▼                        │
│  ┌──────────────────────────────────────────────────┐            │
│  │        3 个生命周期事件 + 1 个上下文过滤           │            │
│  │                                                   │            │
│  │  session_start          — 加载记忆库，预热 Top-5  │            │
│  │  before_agent_start     — 注入记忆到 LLM 上下文   │            │
│  │  context                — 过滤过期注入消息         │            │
│  │  session_shutdown       — 刷新访问时间             │            │
│  └─────────────────────┬────────────────────────────┘            │
│                        │                                         │
│                        ▼                                         │
│  ┌────────────────────────────────────────────┐                 │
│  │              磁盘存储                       │                 │
│  │  ~/.pi/memory/entries.json                  │                 │
│  │    { version, entries: MemoryEntry[] }      │                 │
│  │    1 MB 上限，原子写入 (tmp + rename)        │                 │
│  └────────────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────┘
```

### 文件结构

| 文件 | 职责 | 行数 |
|------|------|------|
| `index.ts` | 入口：生命周期 hooks + 工具/命令注册 | 94 |
| `types.ts` | 数据模型（MemoryEntry, MemoryCategory, MemoryStats） | 30 |
| `storage.ts` | 持久化层：原子 JSON 读写、多维度搜索、Jaccard 去重、冷淘汰 | 215 |
| `tools.ts` | 4 个 registerTool 实现 | 272 |
| `commands.ts` | 3 个 registerCommand 实现 | 106 |
| `SKILL.md` | 供 LLM 交互的技能定义 | 86 |
| `README.md` | 本文档 | — |

---

## 三、4 个 LLM 工具详解

### 1. `memory_store` — 存储知识

**作用**：将一条知识存储到持久记忆库。模型在对话中发现新信息时主动调用。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `category` | string | 是 | 类别：`fact` / `preference` / `habit` / `procedure` / `reference` |
| `title` | string | 是 | 简短标题，用作主搜索索引。例：`"用户偏好: 使用 Shell 管理系统"` |
| `content` | string | 是 | 详细内容 |
| `tags` | string[] | 否 | 标签数组，用于分类检索 |
| `confidence` | number | 否 | 置信度 0-1（默认 0.7） |

**去重逻辑**：

```
memory_store 收到新条目 →
  1. title 精确匹配（忽略大小写） → 更新 content + confidence + recurrence++
  2. content Jaccard 相似度 > 0.7 → 合并到已有条目
  3. 都不匹配 → 创建新条目
```

**返回**：`"已创建/更新/合并记忆: <title>"`。如果总存储 > 900 KB 附带警告。

### 2. `memory_search` — 搜索记忆

**作用**：从持久记忆库中搜索已存储的知识。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `query` | string | 否 | 搜索关键词，匹配标题、标签和内容。不提供时返回 Top-N |
| `category` | string | 否 | 按类别过滤 |
| `tags` | string[] | 否 | 按标签过滤 |
| `limit` | integer | 否 | 返回条数上限（默认 5，最大 20） |

**排序公式**：

```
score = confidence × 0.3         ← 置信度越高越好
      + recency(90天) × 0.2      ← 越新越好
      + min(recurrence/10,1)×0.15 ← 越常被引用越好
      + category boost(0.05-0.1)  ← preference/habit 获得额外权重
      + keyword match × 0.4       ← 标题/标签/内容匹配度
```

**返回**：匹配条目列表，每条显示类别、标题、置信度、引用次数和创建时间。超过 200 字的内容自动截断。

### 3. `memory_stats` — 记忆统计

**作用**：查看记忆库的统计信息。

**无参数**。返回：
- 总条目数
- 各类别分布
- 存储大小（MB）
- 冷数据条目数（>30 天未访问）
- 最早 / 最新记录时间

### 4. `memory_forget` — 删除记忆

**作用**：删除一条或多条记忆。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | 否 | 精确删除指定 ID |
| `category` | string | _id 互斥 | 按类别批量删除，需配合 `olderThan` |
| `olderThan` | string | _id 互斥 | ISO 日期字符串，删除该日期之前的条目 |

**两种删除模式**：
- **精确删除**：指定 `id` 参数
- **批量删除**：同时指定 `category` + `olderThan`，例如删除 2026-06-01 之前的所有 fact 类别条目

---

## 四、3 个斜杠命令

### `/memory:search <query> [--category=] [--limit=N]`

搜索记忆库并展示结果。

```
/memory:search shell preference
/memory:search searxng --category=reference
/memory:search port --limit=10
```

### `/memory:stats`

显示记忆库完整状态：

```
pi-memory
  条目: 5
  大小: 0.01 MB / 1 MB
  冷数据: 1
  分类:
    fact: 2
    preference: 1
    procedure: 1
    reference: 1
```

### `/memory:prune`

清理低价值记忆。带确认对话框，不可撤销。

**清理策略：**
- 置信度 < 0.3 **且** >30 天未访问 → 删除
- 引用次数 < 2 **且** >60 天未访问 → 删除

---

## 五、生命周期事件

### `session_start` — 加载记忆库

```typescript
pi.on("session_start", async () => {
  injectionRound = 0
  warmMemories = searchEntries(entries, undefined, undefined, undefined, 5)
  console.log(`[pi-memory] loaded ${N} entries (${size} MB)`)
})
```

### `before_agent_start` — 注入记忆

前 2 轮对话注入 Top-5 记忆的系统消息，`display: false`（对用户不可见，只发给 LLM）：

```
## 记忆（来自 pi-memory）

偏好:
  - 用户偏好使用 Shell 而非 Python 进行系统管理 [置信度: 0.9]

事实:
  - 仓库 cyfxxx/pi-tools 使用 MIT 许可证 [置信度: 0.8]

流程:
  - 恢复流程: git pull → rebuild.sh → verify services [置信度: 0.7]
```

### `context` — 过滤过期注入

在每轮发送给 LLM 之前，过滤掉上一轮的 memory-context 消息，防止上下文累积。

### `session_shutdown` — 清理状态

重置注入计数器，释放内存。

---

## 六、记忆注入策略

| 轮次 | 注入量 | 注入内容 | Token 估算 |
|------|--------|----------|-----------|
| 第 1 轮 | Top-5 记忆 | 按置信度+时效性+引用频率排序 | ~400 |
| 第 2 轮 | Top-5 记忆 | 同第 1 轮（强化模型认知） | ~400 |
| 第 3+ 轮 | 无自动注入 | 模型按需调用 `memory_search` | 0 |
| **20 轮会话总计** | | | **~800** |

注入只在 input 侧（系统提示），不增加 output token。相比基础会话 token 总量，增量约 **+3-5%**。

---

## 七、数据存储

```
~/.pi/memory/entries.json

{
  "version": 1,
  "entries": [
    {
      "id": "a1b2c3d4-...",
      "category": "preference",
      "title": "用户偏好: 使用 Shell 进行系统管理",
      "content": "用户倾向于使用 Shell 脚本而非 Python 进行系统管理...",
      "tags": ["shell", "system", "preference"],
      "confidence": 0.9,
      "source": "manual",
      "recurrence": 5,
      "createdAt": "2026-07-20T10:00:00.000Z",
      "updatedAt": "2026-07-21T14:30:00.000Z",
      "accessedAt": "2026-07-21T15:00:00.000Z"
    }
  ]
}
```

### 存储约定

| 规则 | 说明 |
|------|------|
| 存储上限 | 1 MB（同 ctx-lite） |
| 写入方式 | 原子写入（write → .tmp → rename），防止写中断导致文件损坏 |
| 版本字段 | `version: 1`，支持未来 schema 演进 |
| 数据目录 | `~/.pi/memory/`，可通过 `PI_MEMORY_DIR` 环境变量覆盖 |
| 清理 | `/memory:prune` 手动触发，或超过 900 KB 时 store 操作附带警告 |

### 环境变量

| 变量 | 用途 |
|------|------|
| `PI_MEMORY_DIR` | 覆盖数据目录路径（默认 `~/.pi/memory/`） |

---

## 八、使用场景

### 跨会话偏好学习

```
第 1 次会话:
  用户: "用 Shell 检查系统状态"
  LLM: (执行 shell 命令)
        → memory_store({ category: "preference",
           title: "用户偏好: 使用 Shell 管理系统",
           content: "用户倾向于使用 Shell 脚本...",
           confidence: 0.9 })

第 2 次会话（自动）:
  before_agent_start → 注入 "用户偏好: 使用 Shell 管理系统"
  用户: "检查系统状态"
  LLM: "执行 bash 命令检查..." (无需再次询问偏好)
```

### 项目知识固化

```
LLM 首次发现项目信息:
  → memory_store({ category: "fact",
     title: "SearXNG 绑定到 127.0.0.1:4000",
     content: "在 settings.yml 中配置...",
     tags: ["searxng", "port", "config"],
     confidence: 0.95 })

后续会话:
  用户: "搜索服务怎么了？"
  LLM: (通过 memory_search 或自动注入回忆起 SearXNG 配置)
       "SearXNG 绑定在 127.0.0.1:4000，让我检查..."
```

### 子代理知识共享

```
子代理 A 执行任务发现：
  → memory_store({ title: "项目使用 MIT 许可证", ... })

子代理 B 后续任务中：
  → memory_search({ query: "license" })
  → 获取结果，无需重复查找
```

### 操作流程固化

```
经过多次恢复操作后:
  → memory_store({ category: "procedure",
     title: "系统恢复流程",
     content: "1. git pull\n2. bash rebuild.sh --yes\n3. verify services",
     confidence: 0.7 })

后续需要恢复时:
  LLM 自动注入的记忆中包含恢复流程，直接执行
```

---

## 九、兼容性

| 扩展 | 关系 |
|------|------|
| **pi-web-toolkit** | 互补。web-toolkit 获取外部信息，pi-memory 固化成果。首次搜索到的内容存起来，后续不再需要重新搜。 |
| **ctx-lite** | 互补，不重叠。ctx-lite 存的是会话级工作状态（`task.current="修复 bug"`），pi-memory 存的是跨会话固化知识（`用户偏好=Shell`）。 |
| **pi-scheduler** | 无冲突。定时任务结果可调用 memory_store 记录发现。 |
| **plan-mode** | 无冲突。plan-mode 管理任务流，pi-memory 管理知识。 |
| **subagent** | 强协同。子代理可通过 memory tools 读写共享知识库。 |
| **pi-backup** | 建议将 `~/.pi/memory/` 加入备份清单。 |

### 工具/命令名称检查

| 类型 | pi-memory 名称 | 已有扩展 | 冲突 |
|------|---------------|---------|------|
| Tool | `memory_store` | schedule_task, ctx_exec, ctx_note, ctx_list, ctx_snap, todo, subagent, web_search, fetch_url | ✓ 无冲突 |
| Tool | `memory_search` | — | ✓ 无冲突 |
| Tool | `memory_stats` | — | ✓ 无冲突 |
| Tool | `memory_forget` | — | ✓ 无冲突 |
| Command | `/memory:search` | /loop, /schedule, /remind, /ctx-lite:*, /todos, /plan, /continue | ✓ 无冲突 |
| Command | `/memory:stats` | — | ✓ 无冲突 |
| Command | `/memory:prune` | — | ✓ 无冲突 |

---

## 十、测试

测试文件：`tests/test.mjs`（独立 Node.js 脚本，无需 vitest）

```bash
node extensions/pi-memory/tests/test.mjs
```

23 项测试覆盖：

| 类别 | 测试项 |
|------|--------|
| **存储层** | loadEntries 空文件 / storeEntry 创建/更新/合并 / deleteEntry 删除/不存在 |
| **搜索** | 排序 / 类别过滤 / 标签过滤 / 关键词匹配标题 / 关键词匹配标签 / 无匹配 |
| **维护** | prune 低置信度冷条目 / prune 低频冷条目 |
| **统计** | getStats 各类别计数 / getTotalSize 大小计算 |
| **算法** | tokenize 中文分词 / Jaccard 相似度（相同/不相交/混合/空数组） |
| **评分** | preference 类别加权高于 fact |
| **冲突检查** | 工具名/命令名与所有已有扩展无冲突 |

---

## 十一、常见问题

### 存储的文件在哪里？

`~/.pi/memory/entries.json`。可通过 `PI_MEMORY_DIR` 环境变量自定义路径。

### 记忆会占用上下文窗口吗？

只会占用前 2 轮（约 800 tokens），且只在 input 侧（系统提示），不增加 output token。第 3 轮起不自动注入，模型按需搜索。

### 记忆库会无限膨胀吗？

上限 1 MB，超 900 KB 时写入操作自动报警。`/memory:prune` 可手动清理低价值条目。

### 如果模型存了错误的知识怎么办？

每条记忆有 `confidence` 置信度字段。注入时模型可以看到置信度，低置信度的知识应手动验证后再次存储修正。

### 记忆会跨会话共享给子代理吗？

子代理也可以调用 `memory_search` 和 `memory_store` 工具。子代理任务中发现的新的项目信息可以写回共享知识库。

### 能和 ctx-lite 一起用吗？

可以。ctx-lite 存会话级工作状态，pi-memory 存跨会话固化知识。两条存储路径完全独立。
