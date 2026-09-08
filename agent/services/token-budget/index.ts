/**
 * services/token-budget/ — Token 预算管理服务
 *
 * 提供 token 估算、预算追踪、输出裁剪、缓存统计等功能。
 * 依赖 Layer 0 (core/)，不依赖任何扩展。
 */

export * from './context-budget.ts'
export * from './prune.ts'
export * from './auto-compact.ts'
export * from './output-archive.ts'
