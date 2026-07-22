# ctx-lite 扩展

> 轻量级上下文管理扩展 — 在 LLM 会话压缩中持久化笔记、执行代码、管理检查点

---

## 目录

- [一、设计理念](#一设计理念)
- [二、架构概览](#二架构概览)
- [三、4 个 LLM 工具详解](#三4-个-llm-工具详解)
  - [ctx_exec](#1-ctx_exec--多语言代码执行)
  - [ctx_note](#2-ctx_note--持久化键值存储)
  - [ctx_list](#3-ctx_list--列出笔记)
  - [ctx_snap](#4-ctx_snap--检查点快照)
- [四、2 个斜杠命令](#四2-个斜杠命令)
- [五、生命周期事件](#五生命周期事件)
- [六、数据存储](#六数据存储)
- [七、使用场景](#七使用场景)
- [八、版本变更](#八版本变更)
- [九、测试](#九测试)

---

## 一、设计理念

LLM 会话存在一个经典问题：**会话压缩（compaction）会让 agent 忘记之前的决策和状态**。

例如：第 10 轮 agent 决定"采用方案 A"，经过 compaction 后第 20 轮它可能完全不记得这个决定。

ctx-lite 提供了一个**轻量级的外部持久化层**，将关键信息存储在 `~/.pi/ctx-lite/notes.json` 中，**不受会话压缩影响**。

核心设计原则：
- **轻量** — 225 行代码，零外部依赖（仅用 Node.js 内置 API）
- **简单** — JSON 文件存储，人类可读可编辑
- **生存力** — 关键事件（compaction 前）自动备份
- **扩展友好** — 4 个显式 LLM 工具，agent 自动发现

---

## 二、架构概览

```
┌──────────────────────────────────────────────────────┐
│                ctx-lite 扩展 (index.ts)               │
│                                                       │
│  ┌──────────────────┐   ┌──────────────────────────┐ │
│  │  4 个 LLM 工具    │   │    2 个斜杠命令           │ │
│  │                   │   │                          │ │
│  │  ctx_exec         │   │  /ctx-lite:status        │ │
│  │  ctx_note         │   │  /ctx-lite:cleanup       │ │
│  │  ctx_list         │   │  /ctx-lite:forget        │ │
│  │  ctx_snap         │   │                          │ │
│  └────────┬──────────┘   └────────────┬─────────────┘ │
│           │                            │              │
│           ▼                            ▼              │
│  ┌────────────────────────────────────────────┐      │
│  │        2 个生命周期事件                     │      │
│  │                                            │      │
│  │  session_before_compact — 压缩前自动保存    │      │
│  │  session_start — 启动时通知笔记数           │      │
│  └────────────────────┬───────────────────────┘      │
│                       │                              │
│                       ▼                              │
│  ┌────────────────────────────────────────┐          │
│  │        磁盘存储                         │          │
│  │  ~/.pi/ctx-lite/                       │          │
│  │    ├── notes.json       # 键值对笔记    │          │
│  │    └── checkpoints/     # 检查点快照    │          │
│  │         ├── my-snap.json               │          │
│  │         └── __compaction_*.json # 自动  │          │
│  └────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────┘
```

### 文件结构

| 文件 | 职责 |
|------|------|
| `index.ts` (295 行) | 全部实现：工具注册、事件绑定、命令注册、文件 I/O |
| `README.md` | 本文档 |
| `CHANGELOG.md` | 变更历史 |
| `ctx-lite.md` | 元数据描述 |

---

## 三、4 个 LLM 工具详解

### 1. `ctx_exec` — 多语言代码执行

**作用**：在子进程中执行代码，stdout 进入上下文窗口。替代"读取大量文件再分析"的模式。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | 是 | 要执行的代码 |
| `language` | string | 否 | 语言：`js` (默认) / `python` / `shell`。省略时从 shebang 自动检测 |
| `description` | string | 否 | 代码功能的简短描述 |
| `timeout` | number | 否 | 超时毫秒数（默认 30000） |
| `max_output` | number | 否 | 输出最大字符数（默认 `2000`）。设为 `0` 不限制。超限后自动截断并显示比例 |

**支持的语言**：

| 语言 | 执行方式 |
|------|----------|
| `js` / `ts` | `node -e <code>` |
| `python` | `python3 -c <code>` |
| `shell` | `bash -c <code>` |

**自动检测逻辑**（`detectLanguage()`）：

```
代码首行有 shebang:
  #!/usr/bin/env python3  → python
  #!/bin/bash             → shell
  #!/usr/bin/env node     → js
  无 shebang              → js (默认)
```

**错误处理**：
- 超时 → `isError: true` + 错误消息
- 非零退出码 → `isError: true` + `Exit code <N>\n<stderr>`
- 不支持的语言 → `isError: true` + 提示支持的语言列表

**使用示例**：

```
// 扫描项目结构（替代逐一读取文件）
ctx_exec code:"const fs=require('fs'); const files=fs.readdirSync('src',{recursive:true}); console.log(JSON.stringify(files.filter(f=>f.endsWith('.ts')).slice(0,20)))"

// 统计数据
ctx_exec code:"print('hello')" language:"python"

// 文件汇总
ctx_exec code:"wc -l src/**/*.ts" language:"shell"
```

### 2. `ctx_note` — 持久化键值存储

**作用**：存储一条笔记到 `notes.json`，跨会话、跨压缩持久化。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 笔记键名。推荐点号命名空间（如 `task.status`）。追加 `@ttl=ISO_TIMESTAMP` 设置自动过期 |
| `value` | string | 否 | 要存储的值。省略时读取；设为 `"null"` 删除 |

**三种操作模式**：

| value 参数 | 行为 |
|------------|------|
| 不传（undefined） | **读取** key 对应的值。不存在返回 `(no note for "key")` |
| `"null"` | **删除** key 及其 TTL 元数据。不存在返回提示 |
| 其他字符串 | **写入** key=value。返回保存大小（KB） |

**TTL 自动过期**：

在 key 后追加 `@ttl=<ISO 8601 时间戳>`，到达过期时间后 `loadNotes()` 自动清除：

```
ctx_note key:"session.temp@ttl=2026-12-31T23:59:59Z" value:"临时数据"
// 内部存储:
//   notes["session.temp"] = "临时数据"
//   notes["__ttl_session.temp"] = "2026-12-31T23:59:59Z"
//   → 到期后自动清除
```

**大小预警**：
当全部笔记总大小超过 **1 MB** 时，写入操作会返回警告信息，提示运行 `/ctx-lite:cleanup` 清理。

### 3. `ctx_list` — 列出笔记

**作用**：列出所有持久化笔记，支持前缀过滤和详情展示。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefix` | string | 否 | 按前缀过滤（如 `"task"` 只显示 `task.xxx`） |
| `detail` | boolean | 否 | 显示完整值（默认 false） |

**输出格式**：

```
Notes (3):
  task.one  (0.1 KB)
  task.two  (0.5 KB) [expires: 2026-12-31T23:59:59Z]
  user.preference  (2.0 KB)
Total: 2.60 MB
```

### 4. `ctx_snap` — 检查点快照

**作用**：手动创建或恢复笔记检查点。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 检查点名。使用 `restore:<name>` 恢复。使用 `list` 列出所有 |

**三种模式**：

| name 格式 | 行为 |
|-----------|------|
| `"before-refactor"` | **保存**：将当前 notes 拍照到 `checkpoints/before-refactor.json` |
| `"restore:before-refactor"` | **恢复**：从 `checkpoints/before-refactor.json` 覆盖 notes.json |
| `"list"` | **列出**：所有检查点（名称、笔记数、大小、时间戳） |

**应用场景**：
- 执行危险操作前：`ctx_snap name:"before-rm"`
- 里程碑节点：`ctx_snap name:"phase-1-complete"`
- 回滚：`ctx_snap name:"restore:before-rm"`

---

## 四、2 个斜杠命令

### `/ctx-lite:status`

显示 ctx-lite 完整状态：

```
ctx-lite
  Notes: 3 (12.5 KB / 0.01 MB)
  Checkpoints: 5 (auto: 3, manual: 2)
  Data dir: /root/.pi/ctx-lite (8 files)
```

### `/ctx-lite:cleanup [--keep N] [--dry-run]`

清理过期笔记和旧自动检查点：

- **TTL 清理**：重新加载 notes 时自动清除过期项
- **自动检查点清理**：只保留最近 N 个 `__compaction_*` 文件（默认 10）
- `--keep N`：自定义保留的自动检查点数量（默认 10）
- `--dry-run`：仅预览将要清理的内容，不实际删除任何文件

```
Cleanup complete:
  Notes: 2 (8.2 KB)
  Auto-checkpoints kept: 5, removed: 10
  Total checkpoints: 7
```

### `/ctx-lite:forget`

删除所有笔记和检查点。带确认对话框，不可撤销。

---

## 五、生命周期事件

### `session_before_compact` — 压缩前自动保存

每次会话压缩前自动将当前 notes 拍照到检查点目录：

```typescript
pi.on("session_before_compact", async () => {
  const snap = { timestamp: Date.now(), notes, compaction: true }
  writeFileSync(`checkpoints/__compaction_${Date.now()}.json`, JSON.stringify(snap))
  // 只保留最近 5 个自动检查点
  const files = readdirSync(CHECKPOINTS_DIR)
    .filter(f => f.startsWith("__compaction_"))
    .sort().reverse()
  for (const f of files.slice(5)) rmSync(f)
})
```

### `session_start` — 启动通知

```
notify: "ctx-lite: 3 notes (0.01 MB), /ctx-lite:status for details"
```

仅在 TUI 模式下、有笔记时触发。如果笔记超过 1 MB 添加额外警告。

---

## 六、数据存储

```
~/.pi/ctx-lite/
├── notes.json                        # 所有笔记（JSON 键值对）
│   { "task.status": "in-progress",
│     "decision.arch": "PostgreSQL",
│     "__ttl_decision.arch": "2026-12-31T23:59:59Z" }
│
└── checkpoints/
    ├── before-refactor.json          # 手动创建的检查点
    │   { timestamp: 1234567890,
    │     notes: { ... } }
    ├── phase-1.json
    ├── __compaction_1743210000000.json  # 自动创建的检查点
    └── __compaction_1743210001000.json
```

### 存储约定

| 键前缀 | 用途 |
|--------|------|
| `__ttl_<key>` | 笔记过期时间（ISO 8601 时间戳） |
| `__compaction_*` | 自动创建的检查点（最多保留 5 个最新） |
| 其他 | 普通笔记 |

### 环境变量

| 变量 | 用途 |
|------|------|
| `CTX_LITE_DIR` | 覆盖数据目录路径（用于测试） |

---

## 七、使用场景

### 跨压缩状态保持

```
用户: "记住我用的是方案 A"
  → ctx_note key:"decision.arch" value:"方案 A"

... 多次对话和 compaction ...

用户: "之前怎么决定的？"
  → ctx_note key:"decision.arch" (读取)
  → "方案 A"
```

### 危险操作前快照

```
agent 准备执行大规模重构:
  → ctx_snap name:"before-refactor"

出问题后:
  → ctx_snap name:"restore:before-refactor"
  → 笔记恢复
```

### 临时数据 + TTL

```
agent: "暂存这周的进度追踪数据，下周末过期"
  → ctx_note key:"sprint.week23@ttl=2026-07-12T23:59:59Z" value:"..."
```

### 替代多文件读取

```
agent 需要了解项目 API 结构:
  不用 read 逐一读取 20 个文件 →
  ctx_exec code:"require('fs').readdirSync('src/api',{recursive:true})
    .filter(f=>f.endsWith('.ts')).forEach(f=>console.log(f))"
  只将文件名列表放入上下文
```

---

## 八、版本变更

### v3 (今次改进)

| 改进 | 说明 |
|------|------|
| `ctx_exec max_output` | 新增 `max_output` 参数（默认 2000 字符），超限自动截断并标记比例 |
| `token-budget 集成` | 集成 `lib/token-budget.ts`，每次执行自动记录 Token 消耗 |

### v2 (上次改进)

| 改进 | 说明 |
|------|------|
| `ctx_exec` 多语言 | 新增 `python`、`shell` 支持 + shebang 自动检测 |
| `ctx_note` TTL | `@ttl=<ISO>` 后缀支持自动过期 |
| `ctx_note` 大小预警 | 总笔记 > 1MB 时自动警告 |
| `ctx_snap list` | `name:"list"` 列出所有检查点 |
| `ctx_list detail` | `detail:true` 显示笔记完整值 |
| `/ctx-lite:cleanup` | 新命令：清理过期笔记 + 旧检查点 |
| `/ctx-lite:cleanup --keep N` | 自定义保留自动检查点数量 |
| `/ctx-lite:forget` | 增强确认信息（显示具体数量） |
| `session_start` | 笔记超 1MB 时额外警告 |
| 测试覆盖 | 17 项测试全部通过 |

### v1 (初始版本)

- 4 个工具：`ctx_exec` / `ctx_note` / `ctx_list` / `ctx_snap`
- `session_before_compact` 自动保存
- 2 个命令：`/ctx-lite:status` / `/ctx-lite:forget`

---

## 九、测试

测试文件：`tests/test.mjs`（独立 Node.js 脚本，无需 vitest）

```bash
node extensions/ctx-lite/tests/test.mjs
```

17 项测试覆盖：
- `loadNotes` / `saveNotes` 读写
- TTL 过期删除
- `getTotalSize` 统计
- `detectLanguage` 语言检测
- `execLanguage` JS / Python / Shell 执行
- `execLanguage` 错误处理（退出码、不支持语言）
- `ctx_snap` 保存 / 恢复 / 列表
- `ctx_list` 前缀过滤 / 详细模式
- 检查点保留轮转
