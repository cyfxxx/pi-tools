# subagent 扩展

> 任务委派扩展 — 在独立上下文中运行专门的子代理

---

## 目录

- [一、设计理念](#一设计理念)
- [二、架构概览](#二架构概览)
- [三、三种执行模式](#三三种执行模式)
- [四、安全模型](#四安全模型)
- [五、Agent 定义](#五agent-定义)
- [六、工作流预设](#六工作流预设)
- [七、TUI 渲染](#七tui-渲染)
- [八、测试](#八测试)

---

## 一、设计理念

LLM 上下文窗口是有限的。主 agent 在做侦察、计划、编写、审阅时，大量中间输出（grep 结果、文件内容、工具调用）占据上下文，导致关键指令被挤出窗口。

**Subagent 的解决方案**：每个子代理在独立 `pi` 进程中运行，拥有独立的上下文窗口。通过 JSON 结构化输出将结果压缩后传回主 agent。

核心设计原则：
- **上下文隔离** — 每个子进程独立上下文，互不干扰
- **任务专业化** — 不同 agent 负责不同角色（侦察/计划/执行/审阅）
- **流式进度** — 实时看到子代理的工具调用和输出

> 注：早期设想中的「模型降级」（LLM API 失败时自动尝试备用模型）**未实现** —— `agents.ts` 只解析 `model` 单字段，无 `fallback_models` 自动降级。

---

## 二、架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                      subagent 扩展                               │
│                                                                  │
│  index.ts (1100 行)                   agents.ts (126 行)        │
│  ┌────────────────────────────┐       ┌──────────────────────┐  │
│  │ 1 个 LLM 工具: subagent    │       │ 核心函数:             │  │
│  │   ├─ execute() 主逻辑      │       │ discoverAgents()     │  │
│  │   ├─ renderCall() TUI 渲染  │       │ loadAgentsFromDir()   │  │
│  │   └─ renderResult() 结果渲染│       │ + 发现缓存 (TTL 5s)   │  │
│  │                            │       └──────────────────────┘  │
│  │ 三种执行模式:               │                                  │
│  │   ├─ single (同步)         │  agent 定义目录                   │
│  │   ├─ parallel              │  ~/.pi/agent/agents/*.md        │
│  │   └─ chain                 │  .pi/agents/*.md  (项目级)       │
│  └────────────────────────────┘                                  │
│                                                                  │
│  agents/                                                         │
│  ├─ scout.md                                                     │
│  ├─ worker.md                                                    │
│  └─ reviewer.md                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 子进程通信协议

```
主 agent                              子 agent (pi --mode json -p --no-session --no-extensions)
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

## 三、三种执行模式

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
| `agentScope` | "user" / "project" / "both" | 否 | agent 来源（默认 "user"） |
| `confirmProjectAgents` | boolean | 否 | 项目 agent 前确认（默认 true） |

### ② Parallel（并行） — tasks[]

多个 agent 并发执行（最大 8 个）：

```
subagent({
  tasks: [
    { agent: "scout", task: "Find models" },
    { agent: "scout", task: "Find providers" },
  ]
})
```

**并发控制（按模型类型自适应）**：
- `MAX_PARALLEL_TASKS = 8` — 最大任务数
- 云端模型（API）：批量并行，`MAX_CONCURRENCY = 4`
- 本地模型（provider 名匹配 ollama/localhost/127.0.0.1/lmstudio/vllm 等）：串行 `LOCAL_CONCURRENCY = 1`，避免多进程竞争 GPU 内存
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

### ③ Chain（链式） — chain[]

顺序执行，`{previous}` 占位符传递前一步输出：

```
subagent({
  chain: [
    { agent: "scout",  task: "Find auth code" },
    { task: "Plan refactor using:\n{previous}" },
    { agent: "worker", task: "Implement:\n{previous}" },
  ]
})
```
（省略 `agent` 的步骤使用内置通用提示）

- 任一步失败 → 立即停止，报告失败步骤
- 后续步骤引用前步输出
- **chain 输出控制**：`{previous}` 替换内容按长度截断，防止上下文膨胀

### 任务级别模型覆盖

Parallel 和 chain 中每个任务可指定 `model`，覆盖 agent 默认模型：

```
subagent({
  chain: [
    { agent: "scout",  task: "..." },      // 使用 agent 默认模型
    { task: "..." },                        // 使用当前会话模型
  ]
})
```

默认继承当前会话模型。如需指定，在 agent YAML 中加 `model:` 字段。

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
---

You are a specialized agent. Your system prompt goes here.
```

### frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | Agent 名称，用于 `subagent({ agent: "name" })` |
| `description` | 是 | 用途描述 |
| `tools` | 否 | 工具白名单（逗号分隔，默认全部） |
| `model` | 否 | 指定模型 ID。省略则继承当前会话模型 |

> ⚠️ `fallback_models`（备用模型自动降级）**未实现**，请勿在 frontmatter 中使用。

### 内置 agent

| Agent | 角色 | 工具 |
|-------|------|------|
| **scout** | 侦察兵 | read, grep, find, ls, bash |
| **worker** | 执行者 | 全部（默认） |
| **reviewer** | 质检员 | read, grep, find, ls, bash |

所有 agent 默认继承当前会话模型。如需指定模型，在 agent YAML 前加 `model:` 字段。

### 默认提示兜底

**agent 是可选的**：调用 `subagent` 时省略 `agent`（或名字不存在），子代理会用内置通用提示执行——融合了探索/计划/执行/审阅四类任务的工作方式与输出要求。自定义角色只是在通用能力之上叠加专用指令。

### Agent 来源目录

| 路径 | 等级 | 加载条件 |
|------|------|----------|
| `~/.pi/agent/agents/*.md` | 用户级 | 始终（默认） |
| `.pi/agents/*.md` | 项目级 | `agentScope:"project"` 或 `"both"` |

同名时，`agentScope:"both"` 下**项目级覆盖用户级**（`discoverAgents` 先写入用户级再写入项目级，同名后者生效）。

---

## 六、工作流预设

工作流预设已并入内置默认提示：`subagent` 链式模式（chain）天然支持多步流程（探索→计划→执行→审阅），通过 `{previous}` 在步骤间传递输出，无需单独的命令文件。

如需固定流程，可直接在 `~/.pi/agent/prompts/` 放置带 frontmatter 的 .md 文件，SDK 会自动注册为 Pi 斜杠命令。

---

## 七、TUI 渲染

| 模式 | 折叠视图（默认） | 展开视图（Ctrl+O） |
|------|-----------------|-------------------|
| **single** | ✓ agent (source), 最后 10 条工具调用, usage | 完整 task, 全部工具调用, Markdown 渲染, 详细 usage |
| **chain** | ✓/✗ N/M steps, 每步 5 条调用 | 每步完整：task → 工具 → Markdown → usage |
| **parallel** | icon + N/M done, M running | 并行每步展开：工具调用 + 输出 + usage |

---

## 八、测试

测试文件：`tests/test.mjs`（独立 Node.js 脚本，无需 vitest/pi 环境）

```bash
node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs
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
