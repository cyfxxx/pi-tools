# ctx-lite (index.ts)

来源：根据 pi skill context-manager 创建的轻量上下文管理扩展

## 功能

注册 4 个上下文工具：

| 工具 | 功能 |
|------|------|
| `ctx_exec` | 执行代码（JS/TS/Python/Shell），仅 stdout 进入上下文窗口 |
| `ctx_note` | 持久化笔记（跨压缩保留），支持 TTL 自动过期 |
| `ctx_list` | 列出所有笔记键名及大小，`detail:true` 显示值 |
| `ctx_snap` | 创建/恢复/列出检查点 |

## 命令

| 命令 | 功能 |
|------|------|
| `/ctx-lite:status` | 显示笔记数、检查点数、存储大小 |
| `/ctx-lite:cleanup` | 清理过期笔记和旧自动检查点 |
| `/ctx-lite:forget` | 删除所有笔记和检查点 |

## 关键特性

- **TTL**: 在 key 后追加 `@ttl=ISO_TIMESTAMP` 可自动过期
- **多语言自动检测**: 支持 shebang（`#!/usr/bin/python` 等）
- **检查点**: `ctx_snap list` 列出所有快照，`ctx_snap restore:<name>` 恢复
- **自动压缩存档**: `session_before_compact` 时自动保存快照（保留最近 5 个）
- **异步执行**: `ctx_exec` 使用 `spawn` + `AbortController`，支持取消和超时

## 变更日志

### 2026-07-07

- **重构**: `execLanguage` 从同步 `spawnSync` 改为异步 `spawn` + `AbortController`，支持信号取消

### 2026-06-11

- **修复**: 工具名称从 `ctx::exec` / `ctx::note` / `ctx::list` / `ctx::snap` 改为 `ctx_exec` / `ctx_note` / `ctx_list` / `ctx_snap`，解决 LLM API 对工具名称 `^[a-zA-Z0-9_-]+$` 的校验失败问题（Error 400 Invalid 'tools[23].function.name'）
