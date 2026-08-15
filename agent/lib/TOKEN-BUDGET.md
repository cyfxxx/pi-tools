# Token Budget 共享模块

> 跨扩展的 Token 用量追踪、上下文预算管理与缓存命中统计

## 概览

`lib/context-budget.ts` 是统一预算模块（纯函数，零依赖），被 **plan-mode**、**pi-browser**、**pi-context**、**pi-memory**（含原 ctx-lite）、**subagent** 等扩展共用。跨扩展共享状态（用量日志/预算/输出裁剪累计）经 `globalThis[Symbol.for('pi.context-budget.state')]` 单例——jiti `moduleCache:false` 使各扩展模块实例独立，模块级变量无法共享（实测：plan-mode 读不到其他扩展记录的用量、压力档位恒 low）。状态为会话级（session_start 重置），无需落盘。

`lib/token-budget.ts` 与 `lib/prune.ts` 现为 re-export 兼容层（`export * from './context-budget.ts'`），旧导入路径零改动。

## 导出的函数

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `estimateTokens(text)` | `string` | `number` | 按 CJK≈2 字符/token、数字≈3.5、拉丁≈4、emoji/非 BMP 字符 1 token/个估算 |
| `truncateByTokens(text, maxTokens)` | `string, number` | `string` | 按 Token 预算二分逼近截断，追加截断标记 |
| `compressOutput(text, targetTokens)` | `string, number` | `string` | 55/35/10 分片压缩（头/尾/中间重要行） |
| `setContextWindow(tokens)` | `number` | `void` | 设置上下文窗口大小（默认 128_000） |
| `recordToolUsage(tool, tokens)` | `string, number` | `void` | 记录单次工具调用的 Token 消耗 |
| `recordOutput(tool, outputLength)` | `string, number` | `void` | 记录工具输出（字符长度，按 3.5 字符/token 折算） |
| `pruneToolOutput(text, tool, allowed?)` | `string, string, number?` | `string` | 输出预算校验：总量 20K / 单工具 5K tokens，超限截断 |
| `getBudgetReport()` | — | `BudgetReport` | 返回用量报告对象 |
| `getTokenPressureTag()` | — | `string \| null` | 根据占用率返回压力档位文案（仅 high/critical 非 null） |
| `getUrgencyHint()` | — | `string \| null` | 剩余不足 20K / 10K 时返回溢出预警提示 |
| `recordCacheUsage(usage)` | `object` | `void` | 聚合缓存命中统计（仅内部累计） |
| `getCacheStats()` | — | `CacheStats` | 返回缓存命中/未命中 token 统计 |
| `resetBudget()` | — | `void` | 重置用量统计（`session_start` 时调用） |
| `resetAllBudgets()` | — | `void` | 重置用量 + 缓存统计 + 上下文窗口 |

## 压力档位（缓存友好设计）

上下文占用率 = 已用 tokens / contextWindow。**低/中（<85%）返回 null、不注入任何文本**；仅在 ≥85% 注入固定文案、≥95% 注入更重文案：

| 等级 | 条件 | 文案 |
|------|------|------|
| 空闲/中 | < 85% | null（不注入） |
| 高 | ≥ 85% | 固定文案"上下文压力较高" |
| 临界 | ≥ 95% | 固定文案"上下文即将耗尽" |

文案**不含精确数字、不含时间戳** → system prompt 在档位内逐字节稳定，DeepSeek 前缀缓存全程命中（命中价约为 miss 的 1/10）。

## 溢出预警 (`getUrgencyHint`)

| 剩余 | 行为 |
|------|------|
| ≤ 20K | 🟠 返回"上下文压力较大"提示 |
| ≤ 10K | 🔴 返回"即将溢出，请用 ctx_note 保存关键信息后 /compact" |

## 压缩算法 (`compressOutput`)

```
输入文本 (text)
  ├── head (55%): 保留下文前半部分
  ├── middle: 仅保留重要行（标题、列表项、DONE/FAIL 标记）
  └── tail (35%): 保留下文结尾部分
```

在 head 和 tail 之间插入 `--- (compressed N chars to M) ---` 标记，保留结构同时大幅压缩。

## 集成方式

各扩展通过相对路径导入（兼容层保证旧路径可用）：

```typescript
// plan-mode, pi-memory, subagent
import { recordToolUsage, estimateTokens, ... } from "../../lib/token-budget.ts"

// pi-web-toolkit (额外一层 src/)
import { recordToolUsage, estimateTokens, ... } from "../../../lib/token-budget.ts"

// 统一预算模块（推荐）
import { pruneToolOutput, estimateTokens } from "../../lib/context-budget.ts"
```

## 集成点

| 扩展 | `session_start` | 每次工具调用 | 每次注入 |
|------|----------------|-------------|---------|
| **plan-mode** | `resetBudget()` | — | `getTokenPressureTag()` 前置到提示词 |
| **pi-web-toolkit** | `resetBudget()` | `recordToolUsage()` / `pruneToolOutput()` | — |
| **pi-memory** | — | `recordToolUsage()`（ctx_exec） | — |
| **subagent** | — | `recordToolUsage()` | 前置预算指令 |
| **pi-context** | — | 聚合 `recordCacheUsage()` | 档位化压力文案（≥85%/95%） |

## 测试

测试文件：`extensions/pi-context/tests/context-budget.test.ts`（vitest，7 项，覆盖 globalThis 单例跨实例互见、usedTotal 会话累计语义、非 BMP 估算、`estimateTokens`、`truncateByTokens`、`compressOutput`、档位文案固定性、缓存统计）；`extensions/pi-web-search/tests/context-budget.test.ts`（旧副本 18 项仍保留）。

```bash
cd extensions/pi-web-search && ./node_modules/.bin/vitest run tests/context-budget.test.ts
```
