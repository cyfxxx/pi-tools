# Changelog — subagent

## [v3]

### Added
- **chain 上下文控制**：每步 `{previous}` 输出做长度截断，防止上下文膨胀

### Changed
- **并行输出截断**：并行模式下每个任务输出 >50KB 时用 SDK `truncateHead` 截断，完整结果保留在 tool details
- **usage 统计**：每步收集 input/output/cacheRead/cacheWrite/cost/contextTokens（经 SDK `calculateContextTokens`）

### Removed
- 移除不存在的异步模式（`async` 参数）、`output` 文件保存、`compress`/`token_budget` 参数的虚假描述（SDK 虚拟模块实测不存在）

## [v2]

### Added
- Agent 发现缓存：5 秒 TTL，避免高频调用重复扫描磁盘（`agents.ts`）

### Fixed
- **模型降级时 signal/streaming 丢失**：fallback 模型现在也监听 abort signal 并流式输出
- **temp 目录清理失败**：`rmdirSync` → `rmSync({ recursive: true })`，避免残留
- **空 agent 提示不友好**：agents 目录为空时显示添加指引

## [v1]

### Added
- 任务委派核心：单代理（single）、并行（parallel）、链式（chain）三种执行模式
- 隔离上下文：每个子代理在独立 `pi` 进程中运行（JSON mode，`pi --mode json -p`）
- 流式输出：实时看到子代理的工具调用和进度
- 并行流式：多个并行子代理同时流式更新
- Markdown 渲染：最终输出格式化（展开视图）
- Usage 追踪：显示子代理的轮次、token、成本、上下文用量
- Abort 支持：Ctrl+C 传播终止子代理进程
- 代理发现：从 `~/.pi/agent/agents/` 和 `.pi/agents/` 自动加载 agent 定义
- Model fallback：agent frontmatter 支持 `fallback_models`，LLM 错误自动降级
- 工作流预设：`implement`（侦察→计划→执行）、`scout-and-plan`、`implement-and-review`

基于 pi 内置示例 `examples/extensions/subagent/` 复制并增强
