# pi-context — 上下文管理扩展

> 上下文管理扩展：8 个事件处理器 + 2 个命令（/usage-diag 诊断 + /tools 用量速览），减少不必要 token 消耗，全程零用户感知。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 上下文优化、token 节省、工具分层 |
| 相关文档 | [pi-autopilot](../pi-autopilot/README.md), [plan-mode](../plan-mode/README.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、关键机制](#六关键机制)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 在长时间会话中会遇到：
- 上下文膨胀导致 token 消耗激增
- 工具输出占用大量上下文空间
- 缓存命中率下降

### 1.2 设计理念

- **零用户感知**：所有优化对用户透明
- **缓存友好**：避免破坏前缀缓存
- **分层处理**：不同层级采用不同策略
- **确定性变换**：同输入必同输出

---

## 二、架构

### 2.1 系统架构图

```
用户输入 → [context handler] → LLM 推理
    ↓
[tool_result handler] → 工具输出截断/压缩
    ↓
[turn_end handler] → 用量记录
    ↓
[agent_settled handler] → 自动压缩判定
    ↓
[session_compact handler] → 压缩完成继续
```

### 2.2 核心组件

| 组件 | 功能 |
|------|------|
| context handler | 过滤诊断消息、工具输出分层擦除、compactionSummary 去重 |
| tool_result handler | 工具输出截断、缓存命中统计 |
| turn_end handler | 每轮用量记录 |
| agent_settled handler | 自动压缩判定 |
| session_compact handler | 压缩完成后自动继续 |
| session_start handler | 会话恢复时立即检查压缩阈值 |
| before_agent_start handler | 注入压力提示、执行效率指令 |

---

## 三、功能

### 3.1 Handler 清单

| # | Hook | 作用 | 省 token |
|---|------|------|----------|
| 1 | `context` | 过滤 usage-diag 诊断消息 + 工具输出分层擦除 + compactionSummary 去重 | 数千/turn |
| 2 | `tool_result` | 工具输出>5KB（bash/read）/>20KB（其他）截断 | 50-80% 工具结果 |
| 3 | `tool_result` | 缓存命中统计（聚合 cacheRead/cacheWrite） | — |
| 4 | `turn_end` | 每轮用量记录（input/缓存/输出） | — |
| 5 | `agent_settled` | 按窗口比例自动压缩判定 + `ctx.compact()` | 大窗口会话持续膨胀 |
| 6 | `session_compact` | 压缩完成后自动继续（AutoContinueGate） | 免手动继续 |
| 7 | `session_start` | 会话恢复时立即检查压缩阈值 | 首轮全量重发 |
| 8 | `before_agent_start` | 注入主动委托建议 + 档位化压力提示 + 执行效率指令 | 上下文利用率 |

### 3.2 命令

| 命令 | 说明 |
|------|------|
| `/usage-diag` | 显示会话 LLM 用量诊断：每轮 input/缓存/输出汇总 + prune 擦除量 + 压缩触发记录 |
| `/tools` | 工具分层管理：`/tools list` 查看核心/休眠组状态；`/tools enable <group>` 手动启用休眠组 |

### 3.3 工具分层与按需加载

**动机**：45 个扩展工具的全量 schema 每轮注入约 5K token（首轮全价 + 每轮 cacheRead），且随功能增加线性增长。

**机制**（`tool-groups.ts`）：
- **核心常驻 29 个**：内置 7 + todo/plan 3 + subagent + ctx 4 + memory 5 + web 3 + tmux 6——schema 每轮完整注入
- **休眠 5 组 26 个**：`browser`（8）/ `admin`（8）/ `autopilot`（含 schedule_task，5）/ `link`（2）/ `verify`（3）——schema 不注入，system prompt 保留 1 行简介
- **启用**：模型调用 `enable_tool("<组名>")` 或 `/tools enable <组名>` → `setActiveTools(全部 − 未启用休眠组)` → 本会话内保持
- **未知工具自动保留**：`computeActiveTools` 用 `getAllTools()` 全集减去休眠组——未来新扩展的工具默认进核心，无需维护名单

**缓存影响（重要）**：
- 工具列表变化 = 请求前缀变化 = DeepSeek 前缀缓存断裂一次（全量重发 + 重建）。启用是低频显式操作（每会话 0-2 次），**禁止实现任何"每轮动态启停"**（每轮断缓存，得不偿失）
- 长会话后阶段（如 200K）断一次 ≈ 5-10 轮命中成本（命中 1/5 折价 vs 全价重发），可控但应避免频繁启停

**故障定位指南**：
- 工具"不见了"（`browser_navigate` 等调用报 unknown tool）→ `/tools list` 查状态；默认休眠属预期行为，用 enable_tool 启用
- 启用后仍不可用 → 检查 `layeringApplied` 逻辑：分层在首个 `before_agent_start` 应用（此时全部扩展已注册）；若扩展加载顺序异常（工具在 pi-context 之后注册）会漏——重启 pi 后重新评估
- 重启后工具恢复休眠 → 预期行为（启用状态为进程内存态，未持久化）；如需常驻把工具移入 `CORE_TOOLS`
- 缓存命中率异常下降 → 检查是否在会话中反复 enable/disable（只允许单向启用，无 disable）；usage-diag 看 cacheRead 占比

---

## 四、配置项

### 4.1 环境变量

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `PI_CONTEXT_COMPACT_LARGE_RATIO` | 0.8 | 大窗口（>256K）压缩阈值比例 |
| `PI_CONTEXT_COMPACT_SMALL_RATIO` | 0.85 | 小窗口（≤256K）压缩阈值比例 |
| `PI_CONTEXT_WINDOW_FALLBACK` | 1M | 上下文解析 fallback 窗口大小 |
| `PI_CONTEXT_ABSOLUTE_TOKENS` | 256K | 绝对阈值（≤0 退回窗口比例） |
| `PI_CONTEXT_TASK_GATE` | on | 任务完成门控（off 可关） |
| `PI_CONTEXT_IDLE_MS` | 600000 | 空闲时间阈值（10 分钟） |
| `PI_CONTEXT_RESTART_TOKENS` | 100K | 重启/恢复压缩阈值 |
| `PRUNE_PROTECT_TOKENS` | 120K | 分层擦除保护带 |
| `PRUNE_MINIMUM_TOKENS` | 80K | 分层擦除最小回收阈值 |

### 4.2 配置方式

设置环境变量：

```bash
export PI_CONTEXT_COMPACT_LARGE_RATIO=0.8
export PI_CONTEXT_COMPACT_SMALL_RATIO=0.85
export PI_CONTEXT_WINDOW_FALLBACK=1048576
```

---

## 五、使用方法

### 5.1 查看用量诊断

```bash
/usage-diag
```

输出示例：
```
会话 LLM 用量诊断:
  总 input: 125,000 tokens
  缓存命中: 85,000 tokens (68%)
  总 output: 45,000 tokens
  prune 擦除: 12,000 tokens
  压缩次数: 2
```

### 5.2 管理工具分层

```bash
/tools list                    # 查看工具状态
/tools enable browser          # 启用 browser 组
/tools enable autopilot        # 启用 autopilot 组
```

### 5.3 自动压缩

系统会根据以下条件自动压缩：
- 上下文 >256K（绝对阈值）
- 任务已完成/阶段性完成
- 本会话无后台任务
- 任务完成后连续 10 分钟无用户操作

### 5.4 手动压缩

```bash
/compact
```

---

## 六、关键机制

### 6.1 自动压缩

**三重门限（2026-08-24 用户策略修订）**：
1. 上下文 >256K（绝对阈值）
2. 任务已完成/阶段性完成（plan-mode 最新 plan.md 无 `- [~]`）
3. 本会话无后台任务（pi-tmux registry 中 owner=本会话的 tmux 会话全部退出）
4. 任务完成后连续 10 分钟无用户操作

全部满足才自动压缩。判定在 `agent_settled`，压缩完成由 `session_compact` 事件通知。

### 6.2 分层擦除

最近 2 轮 + 120K token 保护带内保留，更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构）。预计回收 ≥80K 才应用。

**擦除可恢复**：被擦原文追加落盘 `~/.pi/logs/prune-refs/<sessionId>.md`，Agent 可按路径 grep/read 下钻找回。

### 6.3 工具输出截断

写入时截断——bash/read 5KB（bash 用 `truncateTail` 保留尾部错误/结果，read 用 `truncateHead` 保留开头），其他工具 20KB 兜底。

**连续失败熔断**：同一工具连续失败 ≥3 次 → 该轮结果尾部追加静态熔断提示。

### 6.4 压力提示按档位

基于 auto-compact 阈值比例注入固定文案：
- <75%：不注入
- ≥75%：注入委托建议文案
- ≥90%：注入保存决策文案

档位跳变才改变 system prompt，无压力时与 pi 原生完全一致 → 消息历史缓存前缀稳定。

### 6.5 thinking 档位自适应

`thinking-level.ts` 在 `agent_settled` 按真实 tokens/window 比例驱动 `setThinkingLevel` 升降档：
- critical≥95% 连 2 次降档
- low<70% 连 3 次升回至基准
- 90s 防抖死区，阶梯 low/medium/high

### 6.6 任务完成即时记录

`agent_settled` 确定性写结构化任务记录到 `logs/task-records.jsonl`（用户请求摘要/用量/工具数/是否压缩/是否切档），零 LLM。

---

## 七、已知问题

- **扩展的异步回调不得使用捕获的 ctx**：session 替换后 stale ctx 抛错，需先取值
- **压缩失败不致命**：pi 内置窗口 − reserveTokens 兜底仍在（对 1M 窗口模型约 96.7 万，故本扩展的按比例阈值必不可少）
- **确定性 ≠ 缓存安全**：任何变换（擦除/剪枝/过滤）只要改变消息序列就会破坏前缀缓存，确定性只保证同输入同输出，不保证与上一轮序列一致

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-context
../../node_modules/vitest/vitest.mjs run
```

### 8.2 测试覆盖

- 自动压缩判定
- 分层擦除逻辑
- 工具输出截断
- thinking 档位自适应
- 任务完成记录

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-31 | v1.0 | 连续失败熔断、压缩可逆快照、工具用量账单重构 |
| 2026-08-26 | v1.0 | 擦除可恢复、真实用量校准、thinking 档位自适应 |
| 2026-08-24 | v1.0 | 自动压缩三重门限、重启/恢复压缩阈值 100K |
| 2026-08-22 | v1.0 | thinking 剪枝停用、分层擦除保护带调高 |
| 2026-08-18 | v1.0 | 工具分层与按需加载、append-only 原则 |
| 2026-08-17 | v1.0 | 上下文解析 fallback、溢出兜底 |