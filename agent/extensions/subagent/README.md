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
│  index.ts                             agents.ts                 │
│  ┌────────────────────────────┐       ┌──────────────────────┐  │
│  │ 1 个 LLM 工具: subagent    │       │ 核心函数:             │  │
│  │   ├─ execute() 主逻辑      │       │ discoverAgents()     │  │
│  │   ├─ renderCall() TUI 渲染  │       │ loadAgentsFromDir()   │  │
│  │   └─ renderResult() 结果渲染│       │ formatAgentList()    │  │
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

### 模块与关键函数

| 文件 | 函数 | 职责 |
|------|------|------|
| `index.ts` | `runSubprocessAgent` | spawn 子进程（JSON 模式）、stdout 流解析、usage 累计、30min 兜底超时 |
| | `scheduleKillChain` | SIGTERM→SIGKILL 终止链（5s 升级，close 事件清除定时器） |
| | `mapWithConcurrencyLimit` | 并发调度 + 孤儿防护（任一失败/外部 abort 停止出队并中止已 spawn 子进程） |
| | `resolveAgentTools` / `buildAgentPrompt` | readonly 工具过滤与系统提示只读声明注入 |
| | `isLocalProvider` / `getMaxParallelTasks` / `getMaxConcurrency` | 本地推理判定 + 环境自适应并发上限 |
| | `runSingleAgent` | agent 查找（缺省回退内置通用提示）+ 子进程调用 |
| | `getFinalOutput` / `getResultOutput` / `isFailedResult` | 最终输出提取、失败判定（exitCode/stopReason）、错误输出兜底链 |
| | `applyPreviousPlaceholder` / `taskPreview` / `agentLabel` | `{previous}` 安全替换、TUI 渲染兜底 |
| | `truncateParallelOutput` | 每任务输出截断（50 KB cap） |
| | `formatTokens` / `formatUsageStats` | usage 格式化（渲染用） |
| `agents.ts` | `discoverAgents` | 双目录扫描按 scope 合并（同名项目级覆盖用户级） |
| | `loadAgentsFromDir` | frontmatter 解析（name/description/tools/model/readonly） |
| | `formatAgentList` | agent 清单文本格式化（maxItems 截断） |

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

**并发控制（按模型类型 + 环境自适应）**：
- `MAX_PARALLEL_TASKS = 8` — 桌面环境最大任务数
- 云端模型（API）：批量并行，`MAX_CONCURRENCY = 4`
- 本地模型（provider 名匹配 ollama/localhost/127.0.0.1/lmstudio/vllm 等）：串行 `LOCAL_CONCURRENCY = 1`，避免多进程竞争 GPU 内存
- **环境限制（Termux/Android）**：资源受限（移动端内存/电池），任务上限降为 2、云端并发降为 2（`TERMUX_MAX_PARALLEL`/`TERMUX_CONCURRENCY`，识别：platform=android 或 `TERMUX_VERSION` 环境变量）；本地模型任何环境均串行 1。WSL/Windows/Linux/macOS 无环境限制
- 每任务输出截断到 **50 KB**（完整结果在 tool details 中）
- **孤儿防护**：任一任务失败（如子进程 30min 超时）或外部 abort 后立即停止出队新任务；internal `AbortController` 沿既有 signal→`scheduleKillChain` 链路向已 spawn 的子进程发 SIGTERM（5s 未退出升级 SIGKILL），避免结果无人消费的孤儿子进程

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
| `readonly` | 否 | `true`（或字符串 `"true"`）启用只读模式：spawn 强制过滤写入类工具 bash/edit/write（过滤后为空回退 `read,ls` 最小只读集），并在系统提示前置强制只读声明（双保险） |

> ⚠️ `fallback_models`（备用模型自动降级）**未实现**，请勿在 frontmatter 中使用。

### 内置 agent

| Agent | 角色 | 工具 |
|-------|------|------|
| **scout** | 侦察兵（frontmatter `readonly: true`） | read, grep, find, ls（声明的 bash 被强制过滤） |
| **worker** | 执行者 | 全部（默认） |
| **reviewer** | 质检员 | read, grep, find, ls, bash（提示词约定只读用法，非机制强制） |

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

测试文件：`tests/test.mjs`（独立 Node.js 脚本，无需 vitest/pi环境）；另有 vitest guards 套件 `tests/subagent-guards.test.ts`（7 用例，随 test-all.sh 全量回归跑）

```bash
node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs
```

测试覆盖（按模块，具体计数以 tests/test.mjs 为准）：

| 模块 | 用例规模 | 覆盖内容 |
|------|--------|----------|
| `formatTokens` | 9 | 零、千以下、1k、1.5k、10k、999k、1M、1.5M |
| `formatUsageStats` | 2 | 空、完整 |
| `isFailedResult` | 6 | exitCode、stopReason error/aborted/end/stop |
| `getFinalOutput` | 4 | 空、单消息、最后消息、toolCall 内容 |
| `getResultOutput` | 5 | 成功、errorMessage、stderr、fallback、无输出 |
| `applyPreviousPlaceholder` | 4 | 普通替换、多占位符、$&/$'/$` 不被当作替换模式 |
| `truncateParallelOutput` | 4 | 小文本不截断、大文本截断、边界值、多字节字符安全 |
| `mapWithConcurrencyLimit` | 6 | 空输入、全量映射保序、并发控制峰值、乱序完成保序、失败停出队+内部 abort 信号、外部 abort 停出队 |
| `isLocalProvider` | 4 | 本地判真、云端判假、大小写不敏感、local 词边界不误伤子串 |
| `discoverAgents` | 4 | both 项目覆盖用户、user/project 单侧、readonly 解析 |
| `resolveAgentTools` | 3 | 非 readonly 原样、过滤写入类、全写入类回退最小只读集 |
| `buildAgentPrompt` | 2 | readonly 前置只读声明、非 readonly 原样 |
| `scheduleKillChain` | 3 | 升级 SIGKILL、close 清除定时器、kill 抛错不安排升级 |
| `taskPreview` / `agentLabel` | 5 | 缺 task 空串兜底、{previous} 清理、超长截断、缺名占位、有名原样 |
| 并发环境上限 | 4 | 桌面默认 8/4/1、Termux 降档 2/2、TERMUX_VERSION 变量单独生效 |

---

## 关于 `pi-subagents` npm 包

npm 包 `pi-subagents` 也注册了同名的 `subagent` tool，与本扩展**冲突**。确保 `~/.pi/agent/settings.json` 的 `packages` 数组中**没有**引入 npm 版本。

npm 版功能更丰富（fork 上下文、intercom 通信），本扩展的优势是**零外部依赖**、纯文件部署。
