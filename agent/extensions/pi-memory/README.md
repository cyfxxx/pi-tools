# pi-memory 扩展

> 自主学习记忆扩展（已合并 ctx-lite）— 跨会话持久记忆，让 LLM 不再失忆

---

## 目录

- [一、设计理念](#一设计理念)
- [二、架构概览](#二架构概览)
- [三、自主学习闭环](#三自主学习闭环)
- [四、工具](#四工具)
- [五、斜杠命令](#五斜杠命令)
- [六、每轮常驻注入](#六每轮常驻注入)
- [七、数据存储](#七数据存储)
- [八、与 ctx-lite 的关系](#八与-ctx-lite-的关系)
- [九、测试](#九测试)
- [十、配置](#十配置)

---

## 一、设计理念

LLM 的两大固有限制：**无长期记忆**（每次会话从零开始）与**训练数据过时**（知识截止于训练时点）。pi-memory 用"会话内自主学习 → 跨会话持久"的闭环弥补：

- 会话中的新知识（用户偏好/项目约定/环境事实/流程）**自动提取**入长期记忆库
- 每轮会话**常驻注入**高价值记忆，保持上下文连续
- 记忆通过 Mem0 式四操作（ADD/UPDATE/DELETE/NOOP）**消解冲突、自动去重**
- 词法增强检索（BM25）零依赖，中文 bigram 无分词器也可用

设计原则：
- **零外部依赖** — 仅 Node.js 内置 API + 可选 LLM 提取通道
- **不阻塞会话** — 提取异步执行，失败静默
- **预算可控** — 注入块 ~500 token 常驻，防上下文膨胀
- **数据可迁移** — ctx-lite 全部数据自动迁移

---

## 二、架构概览

```
┌───────────────────────────── pi-memory (index.ts) ─────────────────────────────┐
│                                                                                │
│  生命周期事件                    │   工具（9 个）          命令（8 个）          │
│  ──────────────                │   ──────────           ──────────             │
│  session_start   迁移+报告      │   memory_store        /memory:search         │
│  before_agent_start 常驻注入    │   memory_search       /memory:stats          │
│  session_before_compact 提取    │   memory_stats        /memory:prune          │
│  session_shutdown 提取          │   memory_forget       /memory:digest         │
│                                │   memory_recall       /memory:summary         │
│                                │   ctx_exec   (ctx-lite 迁移)                  │
│                                │   ctx_note            /ctx-lite:status        │
│                                │   ctx_list            /ctx-lite:cleanup       │
│                                │   ctx_snap            /ctx-lite:forget        │
├────────────────────────────────┴───────────────────────────────────────────────┤
│  storage.ts   三库存储（entries/notes/summaries）+ 原子写 + v1→v2 迁移          │
│  extract.ts   提取引擎（LLM 子进程、JSON 容错解析、幂等限频）                    │
│  merge.ts     Mem0 式四操作消解（规则判定，无额外 LLM 调用）                     │
│  retrieval.ts BM25 词法检索 + 质量分混合排序（标题×3/标签×2/内容×1 加权）        │
│  inject.ts    常驻注入块（预算截断、质量分排序、摘要衔接）                        │
│  snapshot.ts  compaction 快照（自动检查点，保留最近 5 个）                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、自主学习闭环

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

提取时机（两次）：
1. **session_before_compact** — compaction 前异步提取（不阻塞压缩）
2. **session_shutdown** — 会话结束提取

提取通道：`pi -p` 子进程（同 pi-cron.sh 离线通道），模型可用 `PI_MEMORY_EXTRACT_MODEL` 覆盖。

幂等保护：同会话同消息指纹 60s 冷却期内不重复提取。

---

## 四、工具

### memory_store / memory_search / memory_stats / memory_forget
跨会话知识库四件套（详见 SKILL.md）。存储自动去重：标题相同→更新，内容相似(>0.7)→合并。

### memory_recall（新增）
综合检索：query 匹配 L1 记忆（BM25+质量分），`summaries: true` 附带最近会话摘要时间线，用于跨会话衔接。

### ctx_exec / ctx_note / ctx_list / ctx_snap（ctx-lite 迁移）
- `ctx_exec` — 子进程执行 JS/TS/Python/Shell，仅 stdout 进上下文（`../../lib/prune.ts` 限流）
- `ctx_note` — 持久键值笔记（TTL 过期支持，`key@ttl=ISO时间`）
- `ctx_list` — 列出笔记键与大小
- `ctx_snap` — 命名检查点保存/恢复（`restore:<name>` / `list`）

---

## 五、斜杠命令

| 命令 | 功能 |
|------|------|
| `/memory:search <q> [--category=] [--limit=N]` | 搜索记忆 |
| `/memory:stats` | 统计（条目/大小/摘要/被取代/冷数据） |
| `/memory:prune` | 清理低价值记忆（需确认） |
| `/memory:digest` | 手动触发当前会话提取 |
| `/memory:summary [N]` | 查看会话摘要时间线 |
| `/ctx-lite:status` | 笔记/检查点状态（兼容） |
| `/ctx-lite:cleanup [--keep=N] [--dry-run]` | 清理（兼容） |
| `/ctx-lite:forget` | 清空笔记+检查点（兼容） |

---

## 六、每轮常驻注入

`before_agent_start` 每轮把「持续记忆」块拼入 systemPrompt（MemGPT 核心块思路）：

```
## 持续记忆（pi-memory 自动注入）
- [preference] 用户偏好: 使用 Shell 管理系统: ...
- [fact] CI 配置已迁移 GitHub Actions: ...
- 会话「修复 CI 配置」: 本次会话修复了...
> pi-memory-injection
```

> **缓存友好**：标记行不带时间戳（数据不变时 system prompt 逐字节稳定，DeepSeek 前缀缓存持续命中）；记忆数据一旦变化，块整体替换、缓存从该点重建。

- 条目按质量分（置信度×0.5 + 时效×0.25 + 引用×0.25）排序，最多 6 条
- 最近 2 条会话摘要衔接（compaction 后上下文连续）
- 预算默认 ~500 token（`PI_MEMORY_INJECT_TOKENS` 可调），超出截断
- 无条目时不注入（零开销）

---

## 七、数据存储

```
~/.pi/memory/
├── entries.json      L1 长期记忆（schema v2: observedAt/supersededBy/deleted）
├── notes.json        L0 工作笔记（ctx-lite 迁移，TTL + _ctx.→_mem. 键改名）
├── summaries.json    L2 会话摘要时间线（最多 50 条）
└── checkpoints/      compaction 自动快照（保留 5）+ 手动检查点
```

- 全部原子写（tmp + rename）
- entries 上限 1 MB（超限提示 /memory:prune）
- 软删除 + superseded 链，统计保留
- 首次启动自动从 `~/.pi/ctx-lite/` 迁移 notes + checkpoints

---

## 八、与 ctx-lite 的关系

ctx-lite 已合并入 pi-memory 并删除：
- 工具 `ctx_exec/ctx_note/ctx_list/ctx_snap` 与命令 `/ctx-lite:*` 全部保留（同名同行为）
- 数据自动迁移（notes.json + checkpoints/ → `~/.pi/memory/`）
- settings.json / tsconfig / conflict-check 已同步，无残留引用

---

## 九、测试

```
cd agent/extensions/pi-memory && npm test   # vitest, 49 用例
```

覆盖：存储迁移/TTL/原子写、四操作消解、冲突取代、BM25 排序、中文 bigram、注入预算截断、提取 JSON 容错解析、幂等限频、全流程 mock runner。

跨扩展验证：`node agent/extensions/tests/conflict-check.mjs`（工具/命令/事件无冲突）。

---

## 十、配置

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PI_MEMORY_DIR` | `~/.pi/memory` | 数据目录 |
| `PI_MEMORY_INJECT_TOKENS` | `500` | 常驻注入预算 |
| `PI_MEMORY_EXTRACT_MODEL` | 当前模型 | 提取用模型（`pi -p` 通道） |
| `CTX_LITE_DIR` | `~/.pi/ctx-lite` | 旧数据迁移源 |
