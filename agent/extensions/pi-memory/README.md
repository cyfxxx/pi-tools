# pi-memory — 自主学习记忆扩展

> 跨会话持久记忆，让 LLM 不再失忆。已合并 ctx-lite，提供自主学习闭环。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 跨会话记忆、自主学习 |
| 相关文档 | [ctx-lite](../../ctx-lite/README.md), [Mem0](https://github.com/mem0ai/mem0) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、数据存储](#六数据存储)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

LLM 的两大固有限制：
- **无长期记忆**：每次会话从零开始
- **训练数据过时**：知识截止于训练时点

### 1.2 设计理念

- **会话内自主学习 → 跨会话持久**的闭环
- **Mem0 式四操作**：ADD/UPDATE/DELETE/NOOP 消解冲突、自动去重
- **语义矛盾检测**：同一主体的对立表达自动取代旧条目
- **写时密钥脱敏**：GitHub token/API key/JWT/Bearer 等自动替换为 [REDACTED:*]

---

## 二、架构

### 2.1 系统架构图

```
┌───────────────────────────── pi-memory (index.ts) ─────────────────────────────┐
│                                                                                │
│  生命周期事件                    │   工具（9 个）          命令（1 个）          │
│  ──────────────                │   ──────────           ──────────             │
│  session_start   迁移+报告      │   memory_store        /memory search          │
│  before_agent_start 常驻注入    │   memory_search       /memory stats           │
│  session_before_compact 提取    │   memory_stats        /memory summary         │
│  session_shutdown 提取          │   memory_forget       /memory prune           │
│                                │   memory_recall       /memory cleanup         │
│                                │   ctx_exec   (ctx-lite 迁移)                  │
│                                │   ctx_note            /memory cleanup --all   │
│                                │   ctx_list            (并入 /memory)          │
│                                │   ctx_snap            (并入 /memory)          │
├────────────────────────────────┴───────────────────────────────────────────────┤
│  storage.ts   三库存储（entries/notes/summaries）+ 原子写 + v1→v2 迁移          │
│  extract.ts   提取引擎（LLM 子进程、JSON 容错解析、幂等限频）                    │
│  merge.ts     Mem0 式四操作消解（规则判定，无额外 LLM 调用）                     │
│  retrieval.ts BM25 词法检索 + 质量分混合排序（标题×3/标签×2/内容×1 加权）        │
│  inject.ts    常驻注入块（预算截断、质量分排序、摘要衔接）                        │
│  snapshot.ts  compaction 快照（自动检查点，保留最近 5 个）                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 入口层 | `index.ts` | 扩展注册和初始化 |
| 存储层 | `storage.ts` | 三库存储（entries/notes/summaries） |
| 提取层 | `extract.ts` | LLM 子进程提取 |
| 合并层 | `merge.ts` | Mem0 式四操作消解 |
| 检索层 | `retrieval.ts` | BM25 词法检索 + 质量分混合排序 |
| 注入层 | `inject.ts` | 常驻注入块 |
| 快照层 | `snapshot.ts` | compaction 快照 |

### 2.3 自主学习闭环

```
   会话进行中                    会话结束/compaction
┌──────────────┐                ┌──────────────────┐
│ memory_store │                │ 提取（LLM 分析）   │
│ (主动记录)     │─┐              │ 五类输出:         │
│ 每轮常驻注入   │ │              │ 决策/事实/偏好/   │
│ (自动回忆)     │ │              │ 约定/教训 + 摘要  │
└──────────────┘ │              └────────┬─────────┘
                 │                       │
                 │   ┌───────────────────▼──────────────┐
                 └──▶│   消解（Mem0 四操作，规则判定）     │
                     │  ADD/UPDATE/DELETE/NOOP           │
                     │  冲突取代: 旧条目标记 superseded    │
                     └───────────────┬──────────────────┘
                                     │
                    ┌────────────────▼──────────────┐
                    │  存储: L1 entries + L2 summaries │
                    └────────────────┬──────────────┘
                                     │
                    ┌────────────────▼──────────────┐
                    │  before_agent_start 每轮注入    │
                    │  高价值记忆 + 最近会话摘要衔接    │
                    └────────────────────────────────┘
```

---

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `memory_store` | `content`, `title?`, `category?`, `tags?`, `environment?` | 存储记忆 |
| `memory_search` | `query`, `category?`, `limit?`, `environment?`, `summaries?`, `asOf?` | 搜索记忆 |
| `memory_stats` | — | 统计记忆库 |
| `memory_forget` | `id` | 删除记忆 |
| `memory_recall` | `query`, `summaries?` | 综合检索 |
| `ctx_exec` | `command`, `lang?` | 子进程执行 JS/TS/Python/Shell |
| `ctx_note` | `key`, `value?`, `ttl?` | 持久键值笔记 |
| `ctx_list` | — | 列出笔记键与大小 |
| `ctx_snap` | `action`, `name?` | 命名检查点保存/恢复 |

### 3.2 命令清单

| 命令 | 功能 |
|------|------|
| `/memory search <q> [--category=] [--limit=N] [--env=]` | 搜索记忆 |
| `/memory stats` | 统计（条目/大小/摘要/被取代/冷数据） |
| `/memory summary [N]` | 查看会话摘要时间线 |
| `/memory prune` | 清理低价值记忆（需确认） |
| `/memory cleanup [--keep=N] [--dry-run]` | 清理过期笔记/旧检查点 |
| `/memory cleanup --all` | 清空笔记+检查点 |

### 3.3 环境标签体系

`environment` 参数可选：
- `all`（缺省，通用）
- `termux`
- `wsl2`
- `linux`
- `macos`
- `windows`

自动提取的条目默认打当前环境标签。注入与检索自动按当前环境过滤。

### 3.4 每轮常驻注入

`before_agent_start` 每轮注入「持续记忆」块：
- 条目按质量分排序，最多 6 条
- 最近会话摘要衔接：按 `ts` 排序取最新 2 条
- 预算默认 ~500 token（`PI_MEMORY_INJECT_TOKENS` 可调）
- 无条目时不注入（零开销）

### 3.5 检索排序增强

1. **时效指数衰减**：`recency = exp(-daysOld/90)`
2. **MMR 主题多样性**：防注入块主题冗余
3. **跨会话 round-robin**：防单会话条目垄断 top 位置
4. **bi-temporal asOf 回溯**：旧事实可回溯、新状态仍为当前态

---

## 四、配置项

### 4.1 环境变量

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PI_MEMORY_DIR` | `~/.pi/memory` | 数据目录 |
| `PI_MEMORY_INJECT_TOKENS` | `500` | 常驻注入预算 |
| `CTX_LITE_DIR` | `~/.pi/ctx-lite` | 旧数据迁移源 |
| `PI_BIN` | `pi`（PATH 解析） | ctx_exec 提取子进程用的 pi 二进制路径 |

---

## 五、使用方法

### 5.1 基本用法

```bash
# 存储记忆
memory_store(content="用户偏好使用 Shell 管理系统", category="preference")

# 搜索记忆
memory_search(query="用户偏好")

# 查看统计
/memory stats

# 清理低价值记忆
/memory prune
```

### 5.2 使用场景示例

**场景 1：自动学习**

```
用户: 我喜欢用 zsh 而不是 bash

→ LLM 调用: memory_store(content="用户偏好: 使用 zsh 而非 bash", category="preference")
→ 记忆自动存储，下次会话自动注入
```

**场景 2：跨会话衔接**

```
[新会话开始]
→ 系统自动注入: "持续记忆: 用户偏好使用 zsh 而非 bash"
→ LLM 已知用户偏好，无需重复询问
```

**场景 3：综合检索**

```
memory_recall(query="zsh 配置", summaries=true)
→ 返回匹配记忆 + 最近会话摘要
```

---

## 六、数据存储

### 6.1 目录结构

```
~/.pi/memory/
├── entries.json      L1 长期记忆
├── notes.json        L0 工作笔记（ctx-lite 迁移）
├── summaries.json    L2 会话摘要时间线（最多 50 条）
└── checkpoints/      compaction 自动快照（保留 5）+ 手动检查点
```

### 6.2 数据特性

- 全部原子写（tmp + rename）
- entries 上限 1 MB（超限提示 /memory prune）
- 软删除 + superseded 链，统计保留
- 首次启动自动从 `~/.pi/ctx-lite/` 迁移 notes + checkpoints

---

## 七、已知问题

- **提取子进程递归**：提取子进程携带 `PI_MEMORY_EXTRACT=1`，其自身不再触发提取
- **互斥锁**：同一时刻仅允许一个提取在跑
- **超时上限**：提取最长 60s（SIGKILL 兜底）
- **幂等保护**：同会话同消息指纹 24h 冷却期内不重复提取

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-memory && npm test   # vitest, 94 用例
```

### 8.2 测试覆盖

- 存储迁移/TTL/原子写
- 四操作消解、冲突取代
- BM25 排序、中文 bigram
- 注入预算截断
- 摘要 upsert 去重/空摘要过滤/ts 排序/截断标记
- 提取 JSON 容错解析
- 幂等限频
- 全流程 mock runner

### 8.3 跨扩展验证

```bash
node agent/extensions/tests/conflict-check.mjs   # 工具/命令/事件无冲突
```

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现自主学习记忆功能 |

---

## 十、与 ctx-lite 的关系

ctx-lite 已合并入 pi-memory：
- 工具 `ctx_exec/ctx_note/ctx_list/ctx_snap` 全部保留（同名同行为）
- 命令 `/ctx-lite:*` 已并入 `/memory cleanup`
- 数据自动迁移（notes.json + checkpoints/ → `~/.pi/memory/`）
- settings.json / tsconfig / conflict-check 已同步，无残留引用