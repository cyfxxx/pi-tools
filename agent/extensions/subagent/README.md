# subagent 扩展

> 任务委派扩展 — 在独立上下文中运行专门的子代理

---

## 目录

- [一、设计理念](#一设计理念)
- [二、架构概览](#二架构概览)
- [三、四种执行模式](#三四种执行模式)
- [四、安全模型](#四安全模型)
- [五、Agent 定义](#五agent-定义)
- [六、工作流预设](#六工作流预设)
- [七、TUI 渲染](#七tui-渲染)
- [八、版本变更](#八版本变更)
- [九、测试](#九测试)

---

## 一、设计理念

LLM 上下文窗口是有限的。主 agent 在做侦察、计划、编写、审阅时，大量中间输出（grep 结果、文件内容、工具调用）占据上下文，导致关键指令被挤出窗口。

**Subagent 的解决方案**：每个子代理在独立 `pi` 进程中运行，拥有独立的上下文窗口。通过 JSON 结构化输出将结果压缩后传回主 agent。

核心设计原则：
- **上下文隔离** — 每个子进程独立上下文，互不干扰
- **任务专业化** — 不同 agent 负责不同角色（侦察/计划/执行/审阅）
- **流式进度** — 实时看到子代理的工具调用和输出
- **模型降级** — LLM API 失败时自动尝试备用模型

---

## 二、架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                      subagent 扩展                               │
│                                                                  │
│  index.ts (1360 行)                    agents.ts (133 行)        │
│  ┌────────────────────────────┐       ┌──────────────────────┐  │
│  │ 1 个 LLM 工具: subagent    │       │ 核心函数:             │  │
│  │   ├─ execute() 主逻辑      │       │ discoverAgents()     │  │
│  │   ├─ renderCall() TUI 渲染  │       │ loadAgentsFromDir()   │  │
│  │   └─ renderResult() 结果渲染│       │ + 发现缓存 (TTL 5s)   │  │
│  │                            │       └──────────────────────┘  │
│  │ 四种执行模式:               │                                  │
│  │   ├─ single (同步/异步)    │  agent 定义目录                   │
│  │   ├─ parallel              │  ~/.pi/agent/agents/*.md        │
│  │   └─ chain                 │  .pi/agents/*.md  (项目级)       │
│  └────────────────────────────┘                                  │
│                                                                  │
│  ├─ prompts/                   ├─ agents/                       │
│  │   implement.md             │   scout.md                      │
│  │   scout-and-plan.md        │   planner.md                    │
│  │   implement-and-review.md  │   worker.md                     │
│                                │   reviewer.md                    │
└──────────────────────────────────────────────────────────────────┘
```

### 子进程通信协议

```
主 agent                              子 agent (pi --mode json -p --no-session)
  │                                          │
  │  spawn("pi", [args])                     │
  │────────────────────────────────────>     │
  │                                          │
  │  stdout: JSON Lines 流                   │
  │  <═══════════════════════════════        │
  │  {"type":"message_end",                  │
  │   "message":{role:"assistant",           │
  │    content:[...], usage:{...}}}          │
  │                                          │
  │  {"type":"tool_result_end",              │
  │   "message":{role:"tool",...}}           │
  │                                          │
  │  exit code 0/1                           │
  │  <════════════════════════════════       │
```

---

## 三、四种执行模式

### ① Single（同步） — 默认

一个 agent 执行一个任务，等待完成：

```
subagent({ agent: "scout", task: "Find all authentication code" })
```

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | string | 是 | Agent 名称 |
| `task` | string | 是 | 任务描述 |
| `cwd` | string | 否 | 工作目录 |
| `async` | boolean | 否 | 后台运行，立即返回 run ID |
| `output` | string | 否 | 保存结果到文件路径 |
| `agentScope` | "user" / "project" / "both" | 否 | agent 来源（默认 "user"） |
| `confirmProjectAgents` | boolean | 否 | 项目 agent 前确认（默认 true） |
| `compress` | boolean | 否 | 是否压缩前一步输出（chain 模式，默认 `true`） |
| `token_budget` | number | 否 | 上下文 token 预算上限，到达后自动截断 |

### ② Single（异步） — async:true

后台运行，立即返回，完成后通知：

```
subagent({ agent: "worker", task: "Refactor module X", async: true })
// → 返回 run ID: a1b2c3d4e5f6
// 完成后 TUI 弹出通知

// 查状态：
subagent({ action: "status" })
subagent({ action: "status", id: "a1b2c3d4e5f6" })
```

**异步结果**持久化在 `~/.pi/subagent-async/<runId>/result.json`，重启不丢失。

### ③ Parallel（并行） — tasks[]

多个 agent 并发执行（最大 8 个，4 并发）：

```
subagent({
  tasks: [
    { agent: "scout", task: "Find models" },
    { agent: "scout", task: "Find providers" },
  ]
})
```

**并发控制**：
- `MAX_PARALLEL_TASKS = 8` — 最大任务数
- `MAX_CONCURRENCY = 4` — 同时运行数
- 每任务输出截断到 **50 KB**（完整结果在 tool details 中）

**结果格式**：

```
Parallel: 2/2 succeeded

### [scout] completed
Model files found: src/models/user.ts, ...

---
### [scout] completed
Provider files found: src/providers/oauth.ts, ...
```

### ④ Chain（链式） — chain[]

顺序执行，`{previous}` 占位符传递前一步输出：

```
subagent({
  chain: [
    { agent: "scout",   task: "Find auth code", output: "auth-context.md" },
    { agent: "planner", task: "Plan refactor using:\n{previous}", compress: true },
    { agent: "worker",  task: "Implement:\n{previous}", token_budget: 4000 },
  ]
})
```

- 任一步失败 → 立即停止，报告失败步骤
- 成功步骤的输出保存到 `output` 指定的文件
- 后续步骤引用前步输出
- **自动压缩**：每步执行时，`{previous}` 替换内容自动压缩至约 2000 字符（`compress:true`，默认），保留首尾关键信息
- **Token 预算**：`token_budget` 指定该步上下文预算上限，超限时自动截断输出

### 任务级别模型覆盖

Parallel 和 chain 中每个任务可指定 `model`，实现**分阶段选择模型**：

```
subagent({
  chain: [
    { agent: "scout",   task: "...", model: "claude-haiku" },
    { agent: "planner", task: "...", model: "claude-sonnet" },
  ]
})
```

---

## 四、安全模型

| 层次 | 策略 |
|------|------|
| **Agent 来源** | 默认只从 `~/.pi/agent/agents/`（用户级）加载 |
| **项目级 agent** | `.pi/agents/*.md` 需要 `agentScope:"both"` 才加载 |
| **交互确认** | 首次使用项目 agent 弹对话框确认 |
| **子进程隔离** | 通过子进程执行，受系统权限限制 |

---

## 五、Agent 定义

Agent 定义是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
fallback_models: google/gemini-3-flash, openai/gpt-5-mini
---

You are a specialized agent. Your system prompt goes here.
```

### frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | Agent 名称，用于 `subagent({ agent: "name" })` |
| `description` | 是 | 用途描述 |
| `tools` | 否 | 工具白名单（逗号分隔，默认全部） |
| `model` | 否 | 使用的模型（默认 pi 的默认模型） |
| `fallback_models` | 否 | 备用模型列表。主模型返回 LLM 错误（API 超时/限流/服务器错误）时自动降级。进程崩溃/内存溢出不重试 |

### 内置 agent

| Agent | 角色 | 工具 | 模型 |
|-------|------|------|------|
| **scout** | 侦察兵 | read, grep, find, ls, bash | Haiku（快速/便宜） |
| **planner** | 参谋长 | read, grep, find, ls（只读） | Sonnet（强推理） |
| **worker** | 执行者 | 全部（默认） | Sonnet |
| **reviewer** | 质检员 | read, grep, find, ls, bash | Sonnet |

### Agent 来源目录

| 路径 | 等级 | 加载条件 |
|------|------|----------|
| `~/.pi/agent/agents/*.md` | 用户级 | 始终（默认） |
| `.pi/agents/*.md` | 项目级 | `agentScope:"project"` 或 `"both"` |

同名时，`agentScope:"both"` 下用户级覆盖项目级。

---

## 六、工作流预设

预设 prompt 文件注册为 Pi 斜杠命令：

| 命令 | 工作流 | 说明 |
|------|--------|------|
| `/implement <query>` | scout → planner → worker | 全流程实现 |
| `/scout-and-plan <query>` | scout → planner | 只计划不做实现 |
| `/implement-and-review <query>` | worker → reviewer → worker | 实现→审阅→修复 |

---

## 七、TUI 渲染

| 模式 | 折叠视图（默认） | 展开视图（Ctrl+O） |
|------|-----------------|-------------------|
| **single** | ✓ agent (source), 最后 10 条工具调用, usage | 完整 task, 全部工具调用, Markdown 渲染, 详细 usage |
| **chain** | ✓/✗ N/M steps, 每步 5 条调用 | 每步完整：task → 工具 → Markdown → usage |
| **parallel** | icon + N/M done, M running | 并行每步展开：工具调用 + 输出 + usage |

---

## 八、版本变更

### v3 (今次改进)

| 改进 | 说明 |
|------|------|
| **compressOutput** | 新增 `compressOutput(text, targetTokens)` 函数，55/35/10 分片（头/尾/中间重要行），保留结构上下文同时压缩体积 |
| **Chain 输出压缩** | 每步 `{previous}` 默认压缩至 2000 字符，防止上下文膨胀 |
| **Token 预算** | chain 每步支持 `token_budget` 参数，超限自动截断；前置预算指令 |
| **token-budget 集成** | 集成 `lib/token-budget.ts`，每次调佣自动记录 Token 用量 |
| **测试覆盖** | 34 项测试全部通过 |

### v2 (上次改进)

| 改进 | 说明 |
|------|------|
| **模型降级修复** | fallback 模型现在也支持 Ctrl+C 中止和流式输出 |
| **异步 output 支持** | `async:true` 与 `output:"path"` 可同时使用 |
| **Agent 发现缓存** | 5 秒 TTL，避免高频调用重复扫描磁盘 |
| **异步结果持久化** | 从 `/tmp` 迁移到 `~/.pi/subagent-async/`，重启不丢失 |
| **空 agent 提示优化** | directories empty 时显示如何添加 agent 的指引 |
| **temp 目录清理** | `rmdirSync` → `rmSync({ recursive: true })`，避免残留 |
| **测试覆盖** | 34 项测试全部通过 |

### v1 (初始版本 + 之前的改进)

- 单代理 / 并行 / 链式三种执行模式
- 异步后台模式（`{ async: true }`）
- 状态查询（`{ action: "status" }`）
- 输出文件管理（`{ output: "path" }`）
- Model fallback 自动降级
- 每任务 model 覆盖
- Agent 自动发现
- 工作流预设

---

## 九、测试

测试文件：`tests/test.mjs`（独立 Node.js 脚本，无需 vitest/pi 环境）

```bash
node extensions/subagent/tests/test.mjs
```

34 项测试覆盖：

| 模块 | 测试数 | 覆盖内容 |
|------|--------|----------|
| `formatTokens` | 9 | 零、千以下、1k、1.5k、10k、999k、1M、1.5M |
| `formatUsageStats` | 2 | 空、完整 |
| `isFailedResult` | 6 | exitCode、stopReason error/aborted/end/stop |
| `getFinalOutput` | 4 | 空、单消息、最后消息、toolCall 内容 |
| `getResultOutput` | 5 | 成功、errorMessage、stderr、fallback、无输出 |
| `truncateParallelOutput` | 4 | 小文本不截断、大文本截断、截断标识、多字节字符安全 |
| `mapWithConcurrencyLimit` | 4 | 空输入、全量映射、并发控制、超限 |

---

## 关于 `pi-subagents` npm 包

npm 包 `pi-subagents` 也注册了同名的 `subagent` tool，与本扩展**冲突**。确保 `~/.pi/agent/settings.json` 的 `packages` 数组中**没有**引入 npm 版本。

npm 版功能更丰富（fork 上下文、intercom 通信），本扩展的优势是**零外部依赖**、纯文件部署。
