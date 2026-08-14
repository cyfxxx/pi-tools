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
- 记忆通过 Mem0 式四操作（ADD/UPDATE/DELETE/NOOP）**消解冲突、自动去重**；含**语义矛盾检测**（同一主体的对立表达如"喜欢→不喜欢/启用→关闭"自动取代旧条目，而非合并）
- 提取提示词采用**时间锚定**（相对时间转绝对日期）、**专有名词保留**、**附带事实**（提问中隐藏信息）等工业实践
- 所有落盘文本经**写时密钥脱敏**（GitHub token/API key/JWT/Bearer 等形态自动替换为 [REDACTED:*]，防止密钥入库）
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

提取通道：`pi -p` 子进程（同 pi-cron.sh 离线通道，使用当前配置的模型）。

防护机制：
- **递归斩断**：提取子进程携带 `PI_MEMORY_EXTRACT=1`，其自身不再触发提取（否则每次提取进程退出又 spawn 下一轮，形成无限链条与并行进程）
- **互斥锁**：`memory/.extract-lock`（PID 存活检测）同一时刻仅允许一个提取在跑
- **超时上限**：提取最长 60s（SIGKILL 兜底），避免会话退出被长尾 LLM 调用阻塞

幂等保护：同会话同消息指纹 60s 冷却期内不重复提取。

---

## 四、工具

### memory_store / memory_search / memory_stats / memory_forget

环境标签体系（v3，2026-08）：`environment` 参数可选 `all`（缺省，通用）/`termux`/`wsl2`/`linux`/`macos`/`windows`——环境专属知识显式打标；注入与检索自动按当前环境过滤（`isEnvVisible`：all + 当前环境可见）。自动提取的条目默认打当前环境标签。检测：`PI_MEMORY_ENV` 覆盖 > `/storage/emulated/0` → termux > `/proc/version` microsoft → wsl2 > `process.platform` darwin → macos / win32 → windows > linux。
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
| `/memory search <q> [--category=] [--limit=N] [--env=]` | 搜索记忆（`--env=termux/wsl2/linux/macos/windows` 按环境过滤，非法值提示） |
| `/memory stats` | 统计（条目/大小/摘要/被取代/冷数据） |
| `/memory summary [N]` | 查看会话摘要时间线 |
| `/memory prune` | 清理低价值记忆（需确认） |
| `/memory cleanup [--keep=N] [--dry-run]` | 清理过期笔记/旧检查点（承接 ctx-lite:cleanup） |
| `/memory cleanup --all` | 清空笔记+检查点（承接 ctx-lite:forget） |

> 精简说明：`/memory:digest` 已移除（compaction/会话结束时自动提取）；`/ctx-lite:*` 三个命令已并入 `/memory cleanup`。

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

### 检索排序增强（M1，2026-08）

候选排序不是纯分数降序，三层增强（借鉴 ruflo SmartRetrieval，轻量版）：

1. **时效指数衰减**：`recency = exp(-daysOld/90)`（半衰期约 62 天），久远记忆缓慢衰减而非 180 天线性归零
2. **MMR 主题多样性（带 banding）**：与最高分差距 <15% 的高分条目**锚定原序**（不参与重排——记忆库增量不破坏缓存前缀）；仅对分数相近的尾部 band 做 MMR 选择（`λ·score − (1−λ)·maxSim`，λ=0.7），防注入块主题冗余
3. **跨会话 round-robin**：按 `lastSessionId` 分组轮转交错，防单会话条目垄断 top 位置（v4 字段，自动提取时打会话标签，手动存储缺省无）

### solutions 类别（M2，2026-08）

`MemoryCategory` 新增 **`solutions`**（成功的解决方案/修复模式）：提取提示词会独立归类本会话成功解决的故障（原因+解决步骤）；注入排序加权 ×1.15 优先展示——新任务开始时优先参考同类成功案例。

### 备选方案：pinned 固定注入（未实现，2026-08 评估暂缓）

**动机**：行为红线类记忆（如"后台长任务不阻塞对话"）靠 qualityScore 竞争进 6 条上限不可靠（新条目 recurrence=0，且 MMR/轮转可能挤出）；一旦漏注入，模型在相关场景下重复犯错。

**设计要点（评估结论）**：
- MemoryEntry 加 `pinned` 字段；`memory_store` 支持 pinned 参数
- inject.ts 在 L1 之前插入 pinned 条目：独立席位（不参与 6 条竞争）+ 独立 token 预算 + **上限 2 条**（防注入块膨胀）
- pinned 区块内容必须稳定（遵守 banding 缓存规则，不破坏 system prompt 前缀缓存）
- 旧数据无 pinned 字段按 undefined=非 pinned 兼容
- 入口管控：仅手动指定（如 procedure 类高价值约束），禁止自动规则（自动会让机制失效）

**暂缓理由**：刚需仅 1 条（tmux_wait 阻塞，已被工具描述警告根治——描述比记忆注入更可靠）；记忆库无其他必须每轮在场的候选。**触发条件：出现 ≥2-3 条必须常驻的行为红线记忆时再实现。**

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
- entries 上限 1 MB（超限提示 /memory prune）
- 软删除 + superseded 链，统计保留
- 首次启动自动从 `~/.pi/ctx-lite/` 迁移 notes + checkpoints

---

## 八、与 ctx-lite 的关系

ctx-lite 已合并入 pi-memory：
- 工具 `ctx_exec/ctx_note/ctx_list/ctx_snap` 全部保留（同名同行为）；命令 `/ctx-lite:*` 已并入 `/memory cleanup`（`/memory cleanup --all` 等价旧 `/ctx-lite:forget`）
- 数据自动迁移（notes.json + checkpoints/ → `~/.pi/memory/`）
- settings.json / tsconfig / conflict-check 已同步，无残留引用

---

## 九、测试

```
cd agent/extensions/pi-memory && npm test   # vitest, 53 用例
```

覆盖：存储迁移/TTL/原子写、四操作消解、冲突取代、BM25 排序、中文 bigram、注入预算截断、提取 JSON 容错解析、幂等限频、全流程 mock runner。

跨扩展验证：`node agent/extensions/tests/conflict-check.mjs`（工具/命令/事件无冲突）。

---

## 十、配置

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PI_MEMORY_DIR` | `~/.pi/memory` | 数据目录 |
| `PI_MEMORY_INJECT_TOKENS` | `500` | 常驻注入预算 |
| `CTX_LITE_DIR` | `~/.pi/ctx-lite` | 旧数据迁移源 |
