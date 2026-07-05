# Changelog — subagent

## [2026-07-04]

### Added
- Agent 发现缓存：5 秒 TTL，避免高频调用重复扫描磁盘（`agents.ts`）
- 测试覆盖：34 项纯函数测试（`/tmp/subagent-test.mjs`）

### Fixed
- **模型降级时 signal/streaming 丢失**：fallback 模型现在也监听 abort signal 并流式输出
- **异步模式忽略 output 参数**：`async:true` 与 `output:"path"` 可同时使用
- **异步结果丢失**：路径从 `/tmp` 改为 `~/.pi/subagent-async/`，重启不丢失
- **temp 目录清理失败**：`rmdirSync` → `rmSync({ recursive: true })`，避免残留
- **空 agent 提示不友好**：agents 目录为空时显示添加指引

### Changed
- SubagentParams 新增 `output` 字段，单模式也支持保存结果到文件

## [2026-06-11]

### Added
- Async 后台模式：`{ async: true }` 参数，后台运行单代理，返回 run ID
- Status 查询：`{ action: "status" }` 列出所有任务，`{ action: "status", id }` 查特定结果
- 输出文件管理：`{ output: "path" }` 保存结果到文件，父上下文只返回文件引用
- Model fallback：agent frontmatter 支持 `fallback_models`，LLM 错误自动降级
- Per-task model 覆盖：chain/parallel 步骤可指定 `model` 参数
- 后台任务完成后通过 `ctx.ui.notify()` 通知用户

### Fixed
- runSingleAgent fallback 循环变量作用域错误
- agents.ts 解析 `fallback_models` frontmatter

## [初始版本]

### Added
- 任务委派核心：单代理、并行 (`parallel`)、链式 (`chain`)、异步 (`async`) 四种执行模式
- 隔离上下文：每个子代理在独立 `pi` 进程中运行
- 流式输出：实时看到子代理的工具调用和进度
- 并行流式：多个并行子代理同时流式更新
- Markdown 渲染：最终输出格式化（展开视图）
- Usage 追踪：显示子代理的轮次、token、成本、上下文用量
- Abort 支持：Ctrl+C 传播终止子代理进程
- 代理发现：从 `~/.pi/agent/agents/` 和 `.pi/agents/` 自动加载 agent 定义
- 工作流预设：`implement`（侦察→计划→执行）、`scout-and-plan`、`implement-and-review`
- 自定义子代理：通过 extensionAPI 内联注册

基于 pi 内置示例 `examples/extensions/subagent/` 复制并增强
