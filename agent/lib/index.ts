/**
 * lib/ — 兼容层（已重构至 core/ + services/）
 *
 * 此文件保留以兼容现有 import 路径。
 * 新代码应直接从 core/ 或 services/ 导入。
 *
 * 重构映射：
 *   lib/config.ts        → core/config.ts
 *   lib/registry.ts      → core/registry.ts
 *   lib/hook-registry.ts → core/hook-registry.ts
 *   lib/secrets.ts       → core/secrets.ts (新增)
 *   lib/context-budget.ts → services/token-budget/context-budget.ts
 *   lib/prune.ts         → services/token-budget/prune.ts
 *   lib/auto-compact.ts  → services/token-budget/auto-compact.ts
 *   lib/output-archive.ts → services/token-budget/output-archive.ts
 *   lib/usage-diag.ts    → services/diagnostics/usage-diag.ts
 *   lib/task-record.ts   → services/diagnostics/task-record.ts
 *   lib/shadow-review.ts → services/shadow-review.ts
 *   lib/note-store.ts    → services/note-store.ts
 *   lib/token-budget.ts  → services/token-budget/context-budget.ts (兼容 re-export)
 */

// Layer 0: core/
export * from '../core/config.ts'
export * from '../core/registry.ts'
export * from '../core/hook-registry.ts'
export * from '../core/secrets.ts'

// Layer 1: services/
export * from '../services/token-budget/context-budget.ts'
export * from '../services/token-budget/prune.ts'
export * from '../services/token-budget/auto-compact.ts'
export * from '../services/token-budget/output-archive.ts'
export * from '../services/diagnostics/usage-diag.ts'
export * from '../services/diagnostics/task-record.ts'
export * from '../services/shadow-review.ts'
export * from '../services/note-store.ts'
