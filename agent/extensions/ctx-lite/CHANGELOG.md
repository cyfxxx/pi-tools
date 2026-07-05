# Changelog — ctx-lite

## [v2] — 2026-07-04

### Added
- `ctx_exec` 多语言支持：新增 `python`、`shell` + shebang 自动检测
- `ctx_note` TTL 自动过期：`key@ttl=<ISO>` 后缀
- `ctx_note` 总大小 > 1MB 自动警告
- `ctx_snap list`：`name:"list"` 列出所有检查点
- `ctx_list detail`：`detail:true` 显示完整值
- `/ctx-lite:cleanup` 命令：清理过期笔记 + 旧自动检查点
- `/ctx-lite:cleanup --keep N`：自定义保留检查点数量
- 17 项自动化测试

### Changed
- `/ctx-lite:forget` 命令增强确认信息（显示具体笔记数和检查点数）
- `session_start` 通知增强：笔记超 1MB 时额外警告
- 工具描述国际化（中英双语）

### Fixed
- 数据目录不支持自定义路径 → 新增 `CTX_LITE_DIR` 环境变量

---

## [v1] — 2026-06-13

### Fixed
- `ctx-lite.ts` → `index.ts` 重命名：Pi 扩展自动发现要求入口文件名为 `index.ts`（或通过 `package.json` 指定），原名未被识别导致扩展未被加载。

### Added
- `ctx_exec` 工具：子进程执行 JS/TS，stdout 进入上下文
- `ctx_note` 工具：持久化命名笔记（`~/.pi/ctx-lite/notes.json`）
- `ctx_list` 工具：列出所有笔记名称和摘要
- `ctx_snap` 工具：创建会话检查点快照
- `session_before_compact` 自动保存
- `/ctx-lite:status` 和 `/ctx-lite:forget` 命令
- `session_start` 笔记数通知

### Fixed
- 工具名从 `ctx::exec` / `ctx::note` / `ctx::list` / `ctx::snap` 改为 `ctx_exec` / `ctx_note` / `ctx_list` / `ctx_snap`，解决 LLM API 对工具名 `^[a-zA-Z0-9_-]+$` 的校验失败问题
