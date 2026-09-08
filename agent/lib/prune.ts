/**
 * 兼容层 + 分层擦除：原输出预算/裁剪函数整合进 services/token-budget/context-budget.ts，
 * 保留 re-export 以便既有扩展 import 路径不变。
 */
export * from '../services/token-budget/context-budget.ts'

/**
 * Prune — 工具输出分层擦除（详见 services/token-budget/prune.ts）
 */
export * from '../services/token-budget/prune.ts'
