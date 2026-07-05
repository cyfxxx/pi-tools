# ctx-lite (index.ts)

来源：根据 pi skill context-manager 创建的轻量上下文管理扩展

## 功能

注册 4 个上下文工具（ctx_exec, ctx_note, ctx_list, ctx_snap），
用于代码执行、持久化笔记、笔记列表和会话检查点。

## 变更日志

### 2026-06-11

- **修复**: 工具名称从 `ctx::exec` / `ctx::note` / `ctx::list` / `ctx::snap` 改为 `ctx_exec` / `ctx_note` / `ctx_list` / `ctx_snap`，解决 LLM API 对工具名称 `^[a-zA-Z0-9_-]+$` 的校验失败问题（Error 400 Invalid 'tools[23].function.name'）

## 待办

- [ ] 了解当前实现后再添加待办
