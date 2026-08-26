# Changelog — subagent

## [v8] - 2026-08-26

### Fixed
- **链式任务 `{previous}` 超 argv 上限整链静默失败（MEDIUM，审计）**：注入上一步全文无截断，超 Linux MAX_ARG_STRLEN(128KB) 时 spawn 报 E2BIG 仅 resolve(1)——新增 `capPreviousOutput()` 96KB 字节级封顶（多字节边界安全 + `[truncated]` 标记）；proc error handler 把 E2BIG/ENOENT 等错误写入 errorMessage+stderr 后再退出，不再静默。

## [v7]

### Changed
- **stderr 输出上限 50KB**：防子代理超量 stderr 撑爆内存/日志
- **整体 30 分钟超时**：超时后 SIGTERM → 宽限后 SIGKILL，exitCode=124 分类（防挂死子代理永久占用进程）

## [v6]

### Fixed
- **链式任务 `{previous}` 替换损坏**：`String.replace` 字符串替换会把上一步输出中的 `$&`、`$'`、美元符+反引号组合解析为替换模式（`$&` 导致占位符被重新插入，`$'` 插入匹配点后的原文）——改为函数替换（`() => previousOutput`）输出原样保留；提取 `applyPreviousPlaceholder()` 导出并补 4 个纯函数测试

## [v4]

### Fixed
- **模型继承 bug**：子进程原本回落到 settings 默认模型，现在继承当前会话模型（agent frontmatter 的 `model` 优先，否则用 `provider/model` 传递）
- **README 测试路径缺失**：补上真实存在的 `tests/test.mjs`（34 项纯函数测试，经 loader 解析 SDK 依赖）

### Changed
- **子进程跳过扩展加载**：`pi` 参数加 `--no-extensions`，子代理无需扩展即可执行（内置工具不受影响）。实测扩展加载约 0.7s，主要启动成本在 SDK ESM 加载
- **工作流预设中文化**：`~/.pi/agent/prompts/` 提示词改为中文（文件名为 `/实现`、`/侦察计划`、`/实现审阅`，即斜杠命令名）

### Removed
- **TODO.md**：内容均已完成或为不存在的虚构功能，删除
- **扩展内 `prompts/` 目录**：SDK 只加载 `~/.pi/agent/prompts/`（用户级），扩展内 prompts 从未被加载，属死文件，删除
- **README 版本变更章节**：修改记录统一收进本文件，README 只保留使用说明

## [v5]

### Changed
- **提示词合并为通用默认提示**：`/实现`、`/侦察计划`、`/实现审阅` 三个工作流提示词合并为一个内置 `DEFAULT_SYSTEM_PROMPT`（融合探索/计划/执行/审阅四类任务的工作方式与输出要求），删除 prompts 目录及斜杠命令
- **agent 可选 + 默认兜底**：`subagent` 的 agent 参数完全可选（single/parallel/chain 均支持省略），名字不存在时用内置通用提示执行，不再报 "Unknown agent"
- **角色精简为 3 个**：保留 scout（侦察）/ worker（执行）/ reviewer（审阅），删除 planner（规划能力已并入默认提示）
- **角色文件中文化**：scout/worker/reviewer 三个角色提示词全部改为中文

### Removed
- `~/.pi/agent/prompts/`（3 个工作流文件）
- `~/.pi/agent/agents/planner.md`
- 工具描述中所有硬编码角色引用（scout→planner→worker 等）

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
