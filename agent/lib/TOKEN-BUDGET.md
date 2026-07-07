# Token Budget 共享模块

> 跨扩展的 Token 用量追踪与上下文预算管理

## 概览

`lib/token-budget.ts` 是一个轻量共享模块（纯函数，零依赖），被 **plan-mode**、**pi-web-toolkit**、**ctx-lite**、**subagent** 四个扩展共用。

## 导出的函数

| 函数 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `estimateTokens(text)` | `string` | `number` | 按 1 token ≈ 3.5 字符估算 Token 数 |
| `truncateByTokens(text, maxTokens)` | `string, number` | `string` | 按 Token 预算截断文本，追加截断标记 |
| `compressOutput(text, targetTokens)` | `string, number` | `string` | 55/35/10 分片压缩（头/尾/中间重要行） |
| `recordToolUsage(tool, tokens)` | `string, number` | `void` | 记录单次工具调用的 Token 消耗 |
| `getBudgetReport()` | — | `BudgetReport` | 返回用量报告对象 |
| `getTokenPressureTag()` | — | `"🔴"` / `"🟡"` / `"🟢"` | 根据总 Token 消耗返回压力等级标签 |
| `getUrgencyHint()` | — | `string \| null` | 剩余不足 20K / 10K 时返回溢出预警提示 |
| `resetBudget()` | — | `void` | 重置所有用量统计（`session_start` 时调用） |

## 压力标签阈值

| 等级 | 标签 | 条件 |
|------|------|------|
| 低 | 🟢 或 null | 剩余 > 20K |
| 中 | 🟡 | 剩余 ≤ 20K |
| 高 | 🔴 | 剩余 ≤ 10K |

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

各扩展通过相对路径导入：

```typescript
// plan-mode, ctx-lite, subagent
import { recordToolUsage, estimateTokens, ... } from "../../lib/token-budget.ts"

// pi-web-toolkit (额外一层 src/)
import { recordToolUsage, estimateTokens, ... } from "../../../lib/token-budget.ts"
```

## 集成点

| 扩展 | `session_start` | 每次工具调用 | 每次注入 |
|------|----------------|-------------|---------|
| **plan-mode** | `resetBudget()` | — | `getTokenPressureTag()` 前置到提示词 |
| **pi-web-toolkit** | `resetBudget()` | `recordToolUsage()` | — |
| **ctx-lite** | — | `recordToolUsage()` | — |
| **subagent** | — | `recordToolUsage()` | 前置预算指令 |

## 测试

测试文件：`tests/token-budget-test.mjs`（独立 Node.js 脚本，无需依赖）

```bash
node lib/tests/token-budget-test.mjs
```

14 项测试覆盖：`estimateTokens`、`truncateByTokens`、`compressOutput`（短文本、压缩标记、结构保留、紧预算）。
