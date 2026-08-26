# Token Budget 共享模块

> 跨扩展的 Token 用量追踪、上下文预算管理与缓存命中统计

## 概览

`lib/context-budget.ts` 是统一预算模块（纯函数，零依赖），被 **plan-mode**、**pi-browser**、**pi-context**、**pi-memory**（含原 ctx-lite）、**subagent** 等扩展共用。跨扩展共享状态（用量日志/预算/输出裁剪累计）经 `globalThis[Symbol.for('pi.context-budget.state')]` 单例——jiti `moduleCache:false` 使各扩展模块实例独立，模块级变量无法共享（实测：plan-mode 读不到其他扩展记录的用量、压力档位恒 low）。状态为会话级（session_start 重置），无需落盘。

`lib/token-budget.ts` 与 `lib/prune.ts` 现为 re-export 兼容层（`export * from './context-budget.ts'`），旧导入路径零改动。

## 导出的函数

### 估算与截断

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `estimateTokens(text)` | `string` | `number` | 按 CJK≈2 字符/token、数字≈3.5、拉丁≈4、emoji/非 BMP 字符 1 token/个估算 |
| `truncateByTokens(text, maxTokens)` | `string, number` | `string` | 按 Token 预算二分逼近截断，追加 `\n\n[截断]` 标记；标记自身预留 6 token（内容+标记≤上限），截断点回退到最近断点（中文句末标点优先，句子边界感知，回退下限 50% 防无标点长串砍太狠） |

> 原 `compressOutput`（55/35/10 分片压缩）已删除；输出压缩由 pi-context 内容路由（JSON 结构压缩 → 错误脱水 → 截断）承担。

### 预算与用量

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `setTotalBudget(budget)` | `number` | `void` | 设置总预算 tokens |
| `setContextWindow(window)` | `number` | `void` | 用真实 contextWindow 校准总预算（pi-context 在 before_agent_start 调用） |
| `setCompactThreshold(t)` | `number` | `void` | **@deprecated**（2026-08-25 起 pressure 分母回归真实窗口，本设置不再参与压力计算，API 保留兼容） |
| `markCompacted()` | — | `void` | 压缩已发生标记：下一轮 setUsedTokens 直接覆盖为新基线（允许 usedTotal 回落） |
| `setUsedTokens(used)` | `number` | `void` | 真实用量校准（pi-context 用 ctx.getContextUsage() 覆盖，避免只统计上报过的工具输出导致口径偏差） |
| `recordToolUsage(tool, tokens)` | `string, number` | `void` | 记录单次工具调用的 Token 消耗 |
| `getBudgetReport()` | — | `BudgetReport` | 返回用量报告对象（含 usedTotal/totalBudget/ratio/pressure 档位） |
| `resetBudget()` | — | `void` | 重置用量统计（`session_start` 时调用） |

### 输出裁剪

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `recordOutput(tool, outputLength)` | `string, number` | `void` | 记录工具输出（字符长度，按 3.5 字符/token 折算） |
| `pruneToolOutput(text, toolName)` | `string, string` | `string` | 输出预算校验：总量 20K / 单工具 5K tokens，超限截断 |
| `getOutputReport()` | — | `string` | 返回工具输出用量报告文本 |
| `resetOutputBudget()` | — | `void` | 重置输出裁剪累计 |

### 缓存统计

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `recordCacheUsage(cacheRead?, cacheWrite?)` | `number?, number?` | `void` | 聚合缓存命中/写入 token 统计（仅内部累计） |
| `getCacheStats()` | — | `CacheStats` | 返回缓存命中/未命中 token 统计 |
| `resetCacheStats()` | — | `void` | 重置缓存统计 |
| `resetAllBudgets()` | — | `void` | 重置用量 + 缓存统计 + 上下文窗口 |

### 注入文案

| 函数 | 返回值 | 说明 |
|------|--------|------|
| `getTokenPressureTag()` | `string \| null` | 压力档位固定文案：low/medium → null；high → `"🟡 上下文已占窗口 85%。"`；critical → `"🔴 上下文已占窗口 95%，即将达到上限。"` |
| `getUrgencyHint()` | `string \| null` | 同档位驱动的溢出预警：high → 🟠 已占窗口 85%；critical → 🔴 即将达到上限（提示压缩自动触发、精确保真细节可先存 ctx_note）；低档位返回 null |

## 压力档位（缓存友好设计）

上下文占用率 = 已用 tokens / contextWindow。**低/中（<85%）返回 null、不注入任何文本**；仅在 ≥85% 注入固定文案、≥95% 注入更重文案：

| 等级 | 条件 | 文案 |
|------|------|------|
| 空闲/中 | < 85% | null（不注入） |
| 高 | ≥ 85% | 🟡 上下文已占窗口 85%。 |
| 临界 | ≥ 95% | 🔴 上下文已占窗口 95%，即将达到上限。 |

文案**不含精确数字、不含时间戳、无指令化措辞** → system prompt 在档位内逐字节稳定，DeepSeek 前缀缓存全程命中（命中价约为 miss 的 1/10）。

## 集成方式

各扩展通过相对路径导入（兼容层保证旧路径可用）：

```typescript
// plan-mode, pi-memory, subagent
import { recordToolUsage, estimateTokens, ... } from "../../lib/token-budget.ts"

// 统一预算模块（推荐）
import { pruneToolOutput, estimateTokens } from "../../lib/context-budget.ts"
```

## 集成点

| 扩展 | `before_agent_start` / `session_start` | 每次工具调用 | 每次注入 |
|------|-------------|-------------|---------|
| **plan-mode** | `resetBudget()` / `setContextWindow()` / `markCompacted()` | — | `getTokenPressureTag()` 前置到提示词 |
| **pi-memory** | — | `recordToolUsage()`（ctx_exec） | — |
| **subagent** | — | `recordToolUsage()` | 前置预算指令 |
| **pi-context** | `setUsedTokens()`（真实用量校准） | 聚合 `recordCacheUsage()` | 档位化压力文案（≥85%/≥95%） |

## 测试

测试文件：`extensions/pi-context/tests/context-budget.test.ts`（vitest，覆盖 globalThis 单例跨实例互见、usedTotal 会话累计语义、非 BMP 估算、`estimateTokens`、`truncateByTokens`（含边界感知/回退下限/标记预算 3 项）、档位文案固定性、缓存统计）；`extensions/pi-web-search/tests/context-budget.test.ts`（旧副本仍保留）。

```bash
cd extensions/pi-context && ../../node_modules/vitest/vitest.mjs run tests/context-budget.test.ts
```
