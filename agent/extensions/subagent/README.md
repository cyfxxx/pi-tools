# subagent — 任务委派扩展

> 在独立上下文中运行专门的子代理，通过 JSON 结构化输出将结果压缩后传回主 agent。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 任务委派、并行执行 |
| 相关文档 | [scout.md](../../agents/scout.md), [worker.md](../../agents/worker.md), [reviewer.md](../../agents/reviewer.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、Agent 定义](#六agent-定义)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

LLM 上下文窗口是有限的。主 agent 在做侦察、计划、编写、审阅时，大量中间输出（grep 结果、文件内容、工具调用）占据上下文，导致关键指令被挤出窗口。

### 1.2 设计理念

- **上下文隔离** — 每个子进程独立上下文，互不干扰
- **任务专业化** — 不同 agent 负责不同角色（侦察/计划/执行/审阅）
- **流式进度** — 实时看到子代理的工具调用和输出

---

## 二、架构

### 2.1 系统架构图

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

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 入口层 | `index.ts` | 扩展注册和初始化 |
| Agent 层 | `agents.ts` | Agent 发现和加载 |
| Agent 定义 | `agents/*.md` | Agent 配置和提示词 |
| 测试层 | `tests/` | 单元测试和集成测试 |

### 2.3 子进程通信协议

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

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `subagent` | `agent?`, `task?`, `tasks?`, `chain?`, `cwd?`, `agentScope?` | 任务委派扩展 |

### 3.2 三种执行模式

#### ① Single（同步） — 默认

一个 agent 执行一个任务，等待完成：

```javascript
subagent({ agent: "scout", task: "Find all authentication code" })
```

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | string | 是 | Agent 名称 |
| `task` | string | 是 | 任务描述 |
| `cwd` | string | 否 | 工作目录 |
| `agentScope` | "user" / "project" / "both" | 否 | agent 来源（默认 "user"） |

#### ② Parallel（并行） — tasks[]

多个 agent 并发执行（最大 8 个）：

```javascript
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
- 本地模型：串行 `LOCAL_CONCURRENCY = 1`，避免多进程竞争 GPU 内存
- **环境限制（Termux/Android）**：任务上限降为 2、云端并发降为 2
- 每任务输出截断到 **50 KB**
- **孤儿防护**：任一任务失败或外部 abort 后立即停止出队新任务

#### ③ Chain（链式） — chain[]

顺序执行，`{previous}` 占位符传递前一步输出：

```javascript
subagent({
  chain: [
    { agent: "scout",  task: "Find auth code" },
    { task: "Plan refactor using:\n{previous}" },
    { agent: "worker", task: "Implement:\n{previous}" },
  ]
})
```

- 任一步失败 → 立即停止，报告失败步骤
- 后续步骤引用前步输出
- **chain 输出控制**：`{previous}` 替换内容按长度截断，防止上下文膨胀

### 3.3 任务级别模型覆盖

Parallel 和 chain 中每个任务可指定 `model`，覆盖 agent 默认模型：

```javascript
subagent({
  chain: [
    { agent: "scout",  task: "..." },      // 使用 agent 默认模型
    { task: "..." },                        // 使用当前会话模型
  ]
})
```

---

## 四、配置项

### 4.1 安全模型

| 层次 | 策略 |
|------|------|
| **Agent 来源** | 默认只从 `~/.pi/agent/agents/`（用户级）加载 |
| **项目级 agent** | `.pi/agents/*.md` 需要 `agentScope:"both"` 才加载 |
| **交互确认** | 首次使用项目 agent 弹对话框确认 |
| **子进程隔离** | 通过子进程执行，受系统权限限制 |

### 4.2 并发限制

| 环境 | 最大任务数 | 云端并发 | 本地并发 |
|------|-----------|---------|---------|
| 桌面环境 | 8 | 4 | 1 |
| Termux/Android | 2 | 2 | 1 |

---

## 五、使用方法

### 5.1 基本用法

```javascript
// 单任务执行
subagent({ agent: "scout", task: "Find all authentication code" })

// 并行执行
subagent({
  tasks: [
    { agent: "scout", task: "Find models" },
    { agent: "scout", task: "Find providers" },
  ]
})

// 链式执行
subagent({
  chain: [
    { agent: "scout",  task: "Find auth code" },
    { task: "Plan refactor using:\n{previous}" },
    { agent: "worker", task: "Implement:\n{previous}" },
  ]
})
```

### 5.2 使用场景示例

**场景 1：代码探索**

```
用户: 找出所有认证相关的代码

→ LLM 调用: subagent({ agent: "scout", task: "Find all authentication code" })
→ 子代理执行探索任务，返回结果
→ LLM 基于结果继续工作
```

**场景 2：并行探索**

```
用户: 同时查找模型和提供者

→ LLM 调用: subagent({
  tasks: [
    { agent: "scout", task: "Find models" },
    { agent: "scout", task: "Find providers" },
  ]
})
→ 两个子代理并行执行，返回合并结果
```

**场景 3：链式工作流**

```
用户: 探索、计划、实现认证重构

→ LLM 调用: subagent({
  chain: [
    { agent: "scout",  task: "Find auth code" },
    { task: "Plan refactor using:\n{previous}" },
    { agent: "worker", task: "Implement:\n{previous}" },
  ]
})
→ 子代理按顺序执行，每步传递结果
```

---

## 六、Agent 定义

### 6.1 Agent 定义格式

Agent 定义是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
---

You are a specialized agent. Your system prompt goes here.
```

### 6.2 frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | Agent 名称，用于 `subagent({ agent: "name" })` |
| `description` | 是 | 用途描述 |
| `tools` | 否 | 工具白名单（逗号分隔，默认全部） |
| `model` | 否 | 指定模型 ID。省略则继承当前会话模型 |
| `readonly` | 否 | `true` 启用只读模式：spawn 强制过滤写入类工具 |

### 6.3 内置 agent

| Agent | 角色 | 工具 |
|-------|------|------|
| **scout** | 侦察兵（readonly: true） | read, grep, find, ls |
| **worker** | 执行者 | 全部（默认） |
| **reviewer** | 质检员 | read, grep, find, ls, bash |

### 6.4 Agent 来源目录

| 路径 | 等级 | 加载条件 |
|------|------|----------|
| `~/.pi/agent/agents/*.md` | 用户级 | 始终（默认） |
| `.pi/agents/*.md` | 项目级 | `agentScope:"project"` 或 `"both"` |

同名时，`agentScope:"both"` 下**项目级覆盖用户级**。

### 6.5 默认提示兜底

**agent 是可选的**：调用 `subagent` 时省略 `agent`（或名字不存在），子代理会用内置通用提示执行——融合了探索/计划/执行/审阅四类任务的工作方式与输出要求。

---

## 七、已知问题

- **`fallback_models`（备用模型自动降级）未实现**：请勿在 frontmatter 中使用
- **npm 包 `pi-subagents` 冲突**：确保 `~/.pi/agent/settings.json` 的 `packages` 数组中没有引入 npm 版本
- **Termux/Android 环境限制**：任务上限降为 2、云端并发降为 2

---

## 八、测试

### 8.1 运行测试

```bash
# 独立测试（无需 vitest/pi 环境）
node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs

# vitest guards 套件
npx vitest run tests/subagent-guards.test.ts
```

### 8.2 测试覆盖

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

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现任务委派功能 |

---

## 十、TUI 渲染

| 模式 | 折叠视图（默认） | 展开视图（Ctrl+O） |
|------|-----------------|-------------------|
| **single** | ✓ agent (source), 最后 10 条工具调用, usage | 完整 task, 全部工具调用, Markdown 渲染, 详细 usage |
| **chain** | ✓/✗ N/M steps, 每步 5 条调用 | 每步完整：task → 工具 → Markdown → usage |
| **parallel** | icon + N/M done, M running | 并行每步展开：工具调用 + 输出 + usage |