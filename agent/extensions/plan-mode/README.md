# Plan Mode Extension

> 只读探索与计划驱动的安全执行模式扩展

---

## 目录

- [一、概述与设计理念](#一概览与设计理念)
- [二、特性清单](#二特性清单)
- [三、两阶段状态机](#三两阶段状态机)
- [四、生命周期与事件流程](#四生命周期与事件流程)
- [五、架构架构详情](#五架构详情)
  - [5.1 文件结构](#51-文件结构)
  - [5.2 核心状态变量](#52-核心状态变量)
  - [5.3 事件处理器详解](#53-事件处理器详解)
  - [5.4 UI 集成](#54-ui-集成)
- [六、安全模型：Bash Allowlist](#六安全模型bash-allowlist)
- [七、计划提取与步骤追踪](#七计划提取与步骤追踪)
- [八、会话持久化与恢复](#八会话持久化与恢复)
- [九、Git 版本管理](#九git-版本管理)
- [十、命令与快捷键参考](#十命令与快捷键参考)
- [十一、使用指南](#十一使用指南)
- [十二、修改与扩展示例](#十二修改与扩展示例)
- [十三、与 Example 版比较](#十三与-example-版比较)
- [十四、待实现特性](#十四待实现特性)
- [十五、附录：安全命令白名单](#十五附录安全命令白名单)

---

## 一、概览与设计理念

**Plan Mode Extension** 是 [Pi Coding Agent](https://pi.dev/) 的一个模式扩展。它解决的核心矛盾是：AI 编程助手在"先分析"还是"先动手"之间容易失控。

**核心理念**：强制 agent **先充分理解代码，再动手修改**。整个过程分为两个隔离的阶段：

1. **Plan Mode（规划模式）** — 只读阶段，agent 只能分析和探索，不能做任何写操作
2. **Execution Mode（执行模式）** — 全权限阶段，agent 按照既定计划一步一步执行

这种设计提供了三重保障：
- **安全性** — 防止 agent 过早做出破坏性操作
- **可追踪性** — 每一步的完成状态清晰可见
- **可复盘性** — 计划的每次迭代都被 git 版本化

---

## 二、特性清单

| 特性 | 说明 |
|------|------|
| **`todo` 工具** | 6 个操作（create/update/list/get/delete/clear），4 状态机（pending→in_progress→completed→deleted） |
| **`task` 工具** | 创建独立子任务描述文件到 `~/.pi/tasks/`，支持并行探索 |
| **TodoOverlay 悬浮层** | 编辑器上方显示任务列表，彩色图标（○/◐/✓）、删除线、溢出折叠 |
| **只读工具集** | 限制可用工具为 read、bash、grep、glob、questionnaire |
| **Bash 白名单** | 只允许白名单中的纯读取 bash 命令 |
| **自动提取计划** | 从 `Plan:` 标题下提取编号步骤，自动通过 reducer 创建任务 |
| **`[DONE:n]` 标记** ~~→ 已移除~~ | 统一使用 `todo update status=completed` 完成步骤 |
| **进度追踪** | TUI 小部件 + TodoOverlay 实时显示完成比例（如 2/5） |
| **会话持久化** | 所有状态（模式、待办、执行状态等）在 session resume 后完整恢复 |
| **追问保护** | Agent 已展示计划后，普通追问（why/what）不会误覆盖计划；只有显式修改请求才产生新版本 |
| **影响分析** | Agent 在规划前必须分析受影响文件、评估风险 |
| **Git 版本化** | 每次计划迭代自动保存到 `~/.pi/plans/plan-<timestamp>/plan.md`，带 git 历史 |
| **Plan Diff** | `/plandiff` 命令通过 git diff 展示当前版本与上一版的差异 |
| **讨论历史** | `/planqa` 命令回溯与该计划相关的完整问答上下文 |
| **Ctrl+Alt+P 快捷键** | 快速切换规划模式 |
| **`--plan` CLI 参数** | 启动时直接进入规划模式 |
| **多阶段交互** | 用户三选一：执行计划 / 停留规划模式 / 精炼计划 |
| **分级注入** | 首轮提示完整 [PLAN MODE] 指令，后续轮次只注入简短摘要，节省上下文 |
| **条件触发选择** | 计划未变化时自动跳过三选一，避免打断正常 Q&A |
| **Q&A 自动清理** | 讨论历史超过 6 条（3 轮）时自动裁剪，防止上下文膨胀 |
| **Token 预算集成** | 每次调用自动记录 token 用量，注入压力标签（🔴🟡🟢）提示上下文窗口压力 |

---

## 三、两阶段状态机

```
                         ┌──────────────────┐
                         │   Normal Mode     │
                         │  (全工具可用)      │
                         │  read / bash /    │
                         │  edit / write     │
                         └────────┬─────────┘
                                  │ /plan 或 --plan
                                  ▼
              ┌──────────────────────────────────────┐
              │          Plan Mode                   │
              │         (只读探索阶段)                 │
              │                                      │
│  可用工具:                            │
│    read / bash / grep / glob /        │
│    questionnaire                       │
              │                                      │
              │  Bash 受 allowlist 限制               │
              │  (cat、grep、ls 等只读命令)            │
              │                                      │
              │  Agent 行为:                          │
              │  ① 提出澄清性问题                      │
              │  ② 分析代码结构和影响                    │
              │  ③ 输出 "Plan:" + 编号步骤              │
              └──────────────────┬───────────────────┘
                                 │ Agent 输出 Plan: 后
                                 ▼
              ┌──────────────────────────────────────┐
              │     用户选择 (agent_end 事件触发)       │
              │                                      │
              │  ┌─────────────────────────────────┐  │
              │  │ ① Execute the plan              │  │
              │  │  → 切换到 Execution Mode          │  │
              │  │  → 恢复全工具访问                 │  │
              │  │  → 开始逐步执行                    │  │
              │  └─────────────────────────────────┘  │
              │  ┌─────────────────────────────────┐  │
              │  │ ② Stay in plan mode             │  │
              │  │  → 停留在只读模式                │  │
              │  │  → 可继续追问/探索                │  │
              │  └─────────────────────────────────┘  │
              │  ┌─────────────────────────────────┐  │
              │  │ ③ Refine the plan               │  │
              │  │  → 打开编辑器让用户修改计划        │  │
              │  │  → 修改后作为新一轮输入            │  │
              │  └─────────────────────────────────┘  │
              └──────────────────┬───────────────────┘
                                 │ 选择 "Execute"
                                 ▼
              ┌──────────────────────────────────────┐
              │       Execution Mode                 │
              │      (全权限执行阶段)                   │
              │                                      │
              │  工具: 恢复完整权限                     │
              │  (read / bash / edit / write 等)      │
              │                                      │
│  Agent 逐步执行每一步                   │
│  使用 `todo update` 标记完成/进行中     │
              │                                      │
              │  TUI 显示实时进度: ☐ / ☑                │
              │                                      │
              │  全部完成 → 自动回到 Normal Mode        │
              │  (executionMode=false, todoItems=[])   │
              └──────────────────────────────────────┘
```

### 状态转换触发条件

| 转换 | 触发方式 |
|------|----------|
| Normal → Plan | `/plan` 命令、`Ctrl+Alt+P` 快捷键、`--plan` 启动参数 |
| Plan → Execution | 用户在 `agent_end` 选择 "Execute the plan" |
| Plan → Plan (stay) | 用户选择 "Stay in plan mode" |
| Plan → Plan (refine) | 用户选择 "Refine the plan"，编辑器中提交后 agent 重新生成 |
| Execution → Normal | 所有步骤标记 `completed` 后自动转换 |

---

## 四、生命周期与事件流程

以下展示用户发出一次请求后的完整事件流及各阶段 plan-mode 的处理逻辑：

```
用户输入（或恢复 session）
    │
    ▼
  session_start  (只在 session 首次启动/恢复时触发)
    │  ├── 检查 --plan flag → 自动启用规划模式
│   ├── 从 session log 恢复持久化状态 (todoItems、executionMode 等)
│  ├── 如果是 resume，重新扫描消息重建完成状态
    │  └── 更新 UI 状态栏和小部件
    │
    ▼
  before_agent_start  (每次用户提交后触发)
    │  ├── Plan Mode:
    │  │   ├── 首轮: 注入完整 [PLAN MODE ACTIVE] 系统提示消息
    │  │   │   (customType: "plan-mode-context")
    │  │   │   内容包括：可用工具限制、要求澄清问题、要求影响分析、
    │  │   │   要求按 "Plan:" 格式输出编号步骤、追问保护提示
    │  │   │
    │  │   ├── 后续轮次 (计划已展示): 注入简短 [PLAN MODE] 摘要
    │  │   │   "当前计划 <todoHash>，可迭代修订。请输出标准 Plan:"
    │  │   │   节省 ~40% 的上下文注入开销
    │  │   │
    │  │   └── 始终前置 Token 压力标签: "🔴🟡🟢 [token: N%]"
    │  │
    │  └── Execution Mode:
│       └── 注入 [EXECUTING PLAN] 系统提示消息（customType: "plan-execution-context"）
│           内容包括：剩余步骤列表、指示按顺序执行、使用 todo update 标记
│           前置 Token 压力标签
    │
    ▼
  tool_call  (每次 LLM 请求调用工具时触发)
    │  └── Plan Mode + bash:
    │       └── 调用 isSafeCommand() 双重检查
    │           ├── 通过 → 允许执行
    │           └── 拒绝 → 返回 { block: true, reason: "..." } 阻止执行
    │
    ▼
  context  (每次 LLM 请求前，可过滤消息)
    │  └── 非 Plan Mode:
    │       └── 过滤掉 customType = "plan-mode-context" 的消息
    │           以及包含 "[PLAN MODE ACTIVE]" 的用户消息
    │
    ▼
  agent 生成回复（多轮 tool_call 循环，略）
    │
    ▼
  turn_end  (每轮 LLM 回复后触发)
    │  └── Execution Mode:
    │       └── 检查 todo 完成状态 → 更新 UI → 持久化
    │
    ▼
  agent_end  (一次用户请求的最终回复完成后触发)
    │
    ├── Execution Mode + 全部完成:
    │   ├── 发送 "Plan Complete!" 完成消息（customType: "plan-complete"）
    │   ├── 重置状态: executionMode=false, todoItems=[]
    │   ├── 恢复 Normal Mode 工具集
    │   └── 持久化
    │
    ├── Execution Mode + 未完成:
    │   └── 直接返回，等待下一轮 turn_end
    │
    └── Plan Mode + 有 UI:
        │
        ├── 提取最后一条 assistant 消息中的 Plan: 步骤
        │   ├── 新计划 → 保存到 git 版本库
        │   ├── 修订版 → 递增迭代号，提交新版本
        │   └── planPresented = true
        │
        ├── 捕获本轮 Q&A 对 (用户输入 + agent 回复)
        │   └── 自动清理：超过 6 条时移除最早的 2 条
        │
        ├── 展示待办列表消息（customType: "plan-todo-list"）
        │
        ├── 条件触发三选一：
        │   ├── todoHash 与上次不同 → 显示三选一
        │   │   ├── "Execute" → planModeEnabled=false, executionMode=true,
        │   │   │    恢复全工具, 发送执行消息触发新一轮 agent
        │   │   ├── "Stay" → 在原地，等待用户新输入
        │   │   └── "Refine" → 打开编辑器，提交后 sendUserMessage()
        │   │
        │   └── todoHash 未变化 → 自动继续（不打断用户 Q&A）
        │       └── 节省每轮 ~50 tokens 的选择提示开销
```

---

## 五、架构详情

### 5.1 文件结构

```
~/.pi/agent/extensions/plan-mode/
├── index.ts        # 主入口：事件绑定 + 命令注册 + 状态机 + 生命周期
├── state.ts        # 类型定义（Task, TaskState）+ 纯 reducer + 状态转换校验
├── store.ts        # 模块级状态单元（getState/commitState/replaceState/resetState）
├── selectors.ts    # 纯选择器（visibleTasks/tasksByStatus/overlayLayout/hasActive）
├── view.ts         # 格式化：彩色图标、状态标签、overlay/command/list/get 行格式
├── overlay.ts      # TodoOverlay 悬浮层（aboveEditor widget，12 行折叠）
├── todo.ts         # todo 工具 + /todos 命令注册
├── utils.ts        # 纯函数：安全命令检查、Plan 提取、[DONE:n] 处理、修订检测
├── README.md       # 说明文档
└── CHANGELOG.md    # 变更日志
```

### 5.2 核心状态变量

所有状态定义在 `index.ts:63-68`：

```typescript
let planModeEnabled = false;    // 是否处于规划模式（只读）
let executionMode = false;      // 是否处于执行模式（全权限）
let planPresented = false;      // 是否已展示计划（防误覆盖）
let planDir: string | null = null; // 当前计划的 git 版本库路径
let qaMessages: QAPair[] = [];  // 与该计划相关的 Q&A 讨论历史
```

### 5.3 事件处理器详解

扩展通过 Pi Coding Agent 的 `pi.on()` API 监听 **6 个生命周期事件**：

#### `pi.on("tool_call", ...)` — Bash 安全拦截
- 只在 `planModeEnabled=true` 且工具名为 `bash` 时生效
- 调用 `isSafeCommand()` 做双重检查
- 不安全命令返回 `{ block: true, reason }` 阻止执行

#### `pi.on("context", ...)` — 消息上下文过滤
- 只在 `planModeEnabled=false` 时生效
- 过滤掉 `customType === "plan-mode-context"` 的消息
- 过滤掉内容包含 `[PLAN MODE ACTIVE]` 的用户消息
- 防止残留的规划模式上下文影响正常对话

#### `pi.on("before_agent_start", ...)` — 注入系统提示
- **Plan Mode**: 注入包含限制说明、行为指引导的 `[PLAN MODE ACTIVE]` 消息
- **Execution Mode**: 注入包含剩余步骤列表的 `[EXECUTING PLAN]` 消息
- 消息类型为 `customType`，`display: false`（不显示在聊天中，只发送给 LLM）

#### `pi.on("turn_end", ...)` — 步骤进度追踪
- 只在 `executionMode=true` 时生效
- 检查任务完成状态，更新 UI、TodoOverlay、持久化
- LLM 使用 `todo update` 工具标记步骤完成/进行中

#### `pi.on("agent_end", ...)` — 核心流程控制
功能最复杂的事件处理器，涵盖三个阶段：

1. **执行完成检查**：
   - 如果所有步骤完成 → 发完成消息、清理状态
   
2. **计划提取与版本管理**：
   - 从最后一条 assistant 消息提取 `Plan:` 步骤
   - 判断是新计划还是修订版（通过 `planPresented` 和 `isPlanRevisionIntent()`）
   - 保存到 git 版本库
   - 捕获 Q&A 对

3. **用户交互选择**：
   - 展示待办列表
   - `ctx.ui.select()` 三选一
   - 根据选择切换状态机

#### `pi.on("session_start", ...)` — 状态恢复
- 检查 `--plan` flag
- 从 session log 恢复持久化状态（`pi.appendEntry("plan-mode", ...)`）
- 在 resume 场景下，从待办列表重建当前完成状态
- 如果恢复后处于规划模式，设置只读工具集

### 5.4 UI 集成

| UI 组件 | 代码 | 视觉效果 |
|---------|------|----------|
| **状态栏** | `ctx.ui.setStatus("plan-mode", ...)` | 执行时显示 `2/5`，规划时显示 `plan` |
| **小部件** | `ctx.ui.setWidget("plan-todos", [...])` | 步骤列表：`☐ 步骤描述` / `☑ 已完成步骤` |
| **选择提示** | `ctx.ui.select("Plan mode - what next?", [...])` | 执行/停留/精炼 三选一 |
| **编辑器** | `ctx.ui.editor("Refine the plan:", "")` | 精炼计划时打开文本编辑器 |
| **通知** | `ctx.ui.notify(...)` | 信息提示（启用/禁用/无待办等） |
| **消息** | `pi.sendMessage({ customType, content, display })` | 在聊天中展示计划完成、diff、QA 历史等 |

---

## 六、安全模型：Bash Allowlist

安全模型位于 `utils.ts:97-101`，采用**双重检查**机制：

```typescript
export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}
```

**规则**：命令必须同时满足 **不在黑名单** 且 **在白名单中** 才放行。

### 黑名单（DESTRUCTIVE_PATTERNS）

覆盖以下类别：

| 类别 | 条目 |
|------|------|
| 文件操作 | `rm` `rmdir` `mv` `cp` `mkdir` `touch` `chmod` `chown` `ln` `tee` `dd` `shred` `truncate` |
| 重定向 | `>` `>>` |
| 包管理器 | `npm install/uninstall` `yarn add/remove` `pnpm add/remove` `pip install` `apt install` `brew install` |
| Git 写操作 | `git add/commit/push/pull/merge/reset/checkout` 等 |
| 系统 | `sudo` `su` `kill` `reboot` `shutdown` `systemctl start` `service start` |
| 编辑器 | `vim` `nano` `emacs` `code` `subl` |

### 白名单（SAFE_PATTERNS）

| 类别 | 条目 |
|------|------|
| 文件查看 | `cat` `head` `tail` `less` `more` `wc` `sort` `uniq` `diff` `file` `stat` `du` `df` `tree` |
| 搜索 | `grep` `find` `rg` `fd` `awk` `jq` `sed -n` |
| 目录 | `ls` `pwd` `which` `whereis` `type` |
| 系统信息 | `uname` `whoami` `id` `date` `uptime` `free` `ps` `top` `htop` `env` `printenv` `cal` |
| Git 读 | `git status/log/diff/show/branch/remote/ls-*` |
| 包信息 | `npm list/ls/view/info/search/outdated/audit` `yarn list/info/why/audit` |
| 网络 | `curl` `wget -O -` |
| 其他 | `echo` `printf` `node --version` `python --version` `bat` `eza` |

### 安全设计要点

1. **双重检查**：防止单一规则遗漏（例如一个命令不在黑名单但也不在白名单 → 拒绝）
2. **正则精确性**：`^\s*cat\b` 使用行首锚定 + 词边界，防止 `cat foo | something_dangerous` 中的误判
3. **Git 读/写分离**：`git status` 允许，`git push` 禁止
4. **重定向保护**：`(^|[^<])>` 模式防止输出重定向覆盖文件
5. **前缀空格处理**：所有白名单正则以 `^\s*` 开头，兼容前导空格

---

## 七、计划提取与步骤追踪

### 7.1 计划提取流程

Agent 在规划模式下按以下格式输出计划：

```
计划前的分析说明...

Plan:
1. 分析当前实现代码
2. 编写新的配置文件
3. 添加单元测试
```

**提取流程**（`extractTodoItems()`, `utils.ts:129-157`）：

1. 搜索 `Plan:`（或 `**Plan:**`）标题
2. 在标题后的文本中用正则 `^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)` 匹配编号步骤
3. 过滤条件：文本 ≥ 5 字符、不以 `` ` `` 或 `/` 开头
4. 调用 `cleanStepText()` 清洗：去 markdown 格式、去首行动词、截断 50 字、首字母大写

### 7.2 步骤进度追踪

Agent 在执行过程中使用 `todo update` 工具标记步骤状态。例如：

```
→ LLM 调用: todo update id=1 status=in_progress activeForm="正在分析代码"
→ LLM 调用: todo update id=1 status=completed
```

**追踪流程**（`turn_end` 事件）：

```
turn_end 触发
  → reducer 已通过 todo 工具更新状态
  → updateStatus(ctx) 刷新 UI（状态栏 & 小部件）
  → persistState() 持久化到 session log
```

### 7.3 `cleanStepText()` 清洗规则

```typescript
// 输入: "Create the new configuration file for the database"
// 输出: "New configuration file for the database..."

步骤:
1. 去除 markdown 粗体/斜体: **text** → text
2. 去除行首动作动词: Use/Run/Execute/Create/Update/Add...
3. 合并多余空白
4. 首字母大写
5. 超过 50 字符则截断并加 `...`
```

---

## 八、会话持久化与恢复

### 持久化

通过 `pi.appendEntry()` 将状态保存到 session log：

```typescript
function persistState(): void {
  const state = getState();
  pi.appendEntry("plan-mode", {
    enabled: planModeEnabled,
    tasks: state.tasks,
    nextId: state.nextId,
    executing: executionMode,
    planPresented,
    planDir,
    qaMessages,
  });
}
```

持久化在以下时机触发：
- 每次 `turn_end`（执行步骤变化后）
- 每次 `agent_end`（计划更新、状态切换后）
- `session_start` 恢复时

### 恢复

在 `session_start` 事件中恢复（`index.ts:481-549`）：

1. 从 `ctx.sessionManager.getEntries()` 中找到最后一个 `customType === "plan-mode"` 的 entry
2. 恢复所有状态变量
3. **关键设计 - Resume 安全恢复**：
   - 如果是 resume（以前存在的 session），且处于 execution mode
   - 找到最后一次 `"plan-mode-execute"` custom message 的位置
   - **只扫描此标记之后**的 assistant 消息
   - 重新运行 `markCompletedSteps()` 重建当前完成状态
   - 这个机制防止从历史 session 残留的 `[DONE:n]` 中恢复错误状态

---

## 九、Git 版本管理

### 存储位置

```
~/.pi/plans/plan-<timestamp>/
└── plan.md
```

每个新计划在首次保存时自动执行 `git init`，后续迭代通过 `git commit` 追加。

### 版本化流程

```typescript
// index.ts:125-152
async function savePlanIteration(planText: string, iteration: number): Promise<string> {
  const timestamp = Date.now();
  const dir = planDir ?? join(PLANS_DIR, `plan-${timestamp}`);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.md"), planText);

  if (iteration === 1 || !planDir) {
    execSync("git init && git add plan.md && git commit -m 'initial'", { cwd: dir });
  } else {
    execSync(`git add plan.md && git commit -m 'iteration ${iteration}'`, { cwd: planDir });
  }
  return dir;
}
```

### `/plandiff` 命令

```typescript
// index.ts:186-214
// 执行 git diff HEAD~1..HEAD -- plan.md
// 如果没有上一版本，回退到 git show --stat HEAD
// 结果通过 customType: "plan-diff" 消息展示
```

### `/planqa` 命令

回溯 `qaMessages` 数组中记录的所有用户-agent 问答对，按时间顺序展示。

---

## 十、命令与快捷键参考

### 命令

| 命令 | 描述 | 实现位置 |
|------|------|----------|
| `/plan` | 切换规划模式（只读探索） | `index.ts:180-182` |
| `/todos` | 按状态分组显示所有计划任务 | `todo.ts` |
| `/plandiff` | 显示当前与上一版本规划的差异 | `index.ts:192-220` |
| `/planqa` | 显示当前规划讨论的问答历史 | `index.ts:222-248` |

### 工具

| 工具 | 描述 | 操作 |
|------|------|------|
| `todo` | 管理计划任务列表 | create / update / list / get / delete / clear |
| `task` | 创建独立子任务（保存到 `~/.pi/tasks/`） | description + context |

**todo 工具参数：**
- `action` (必填): create / update / list / get / delete / clear
- `subject`: 任务标题（create 必填）
- `description`: 详细描述
- `activeForm`: 进行中状态标签（如"正在编写测试"）
- `status`: pending / in_progress / completed / deleted
- `id`: 任务 ID（update/get/delete 必填）
- `includeDeleted`: list 时是否包含已归档任务

**task 工具参数：**
- `description` (必填): 子任务详细描述
- `context`: 子任务需要的上下文信息

### 快捷键

| 快捷键 | 操作 | 实现位置 |
|--------|------|----------|
| `Ctrl+Alt+P` | 切换规划模式 | `index.ts:240-243` |

### CLI 参数

| 参数 | 描述 | 实现位置 |
|------|------|----------|
| `--plan` | 以规划模式启动（只读） | `index.ts:70-74` |

---

## 十一、使用指南

### 场景 1：新功能开发

```bash
pi --plan   # 以规划模式启动
```
1. 在规划模式中询问 agent："分析现有代码，为添加用户管理系统制定计划"
2. Agent 提出澄清问题、执行影响分析
3. Agent 输出编号计划
4. 查看计划，如果满意选择 "执行计划（追踪进度）"
5. Agent 逐步执行，使用 `todo update` 标记完成步骤
6. 全部完成后自动提示

### 场景 2：使用 todo 工具精细控制

执行模式中，LLM 可直接使用 `todo` 工具操作任务：

- `todo create` — 新建任务（如发现遗漏步骤）
- `todo update status=in_progress activeForm="正在编写代码"` — 标记开始
- `todo update status=completed` — 标记完成
- `todo list` — 查看所有任务
- `todo get id=N` — 查看任务详情

### 场景 3：使用 task 工具创建子任务

遇到可独立并行执行的任务时，可使用 `task` 工具创建子任务文件：

```
→ LLM 调用: task(description="分析用户模块的数据库模式",
                  context="项目在 /root/myapp，关注 models/user.py")
→ 返回:  子任务已创建: /root/.pi/tasks/task-123456789.md
          请用户在新会话中打开此文件继续执行。
          当前会话继续主任务。
```

### 场景 4：后续追问与修订

计划展示后，以下对话**不会**覆盖计划：
- "为什么需要改这个文件？"
- "这个方案的影响范围是什么？"
- "可不可以换一种方式？"

以下对话**会**生成新版本的计划：
- "请修改计划的第 3 步"
- "更新计划，加入数据库迁移"
- "修订计划，去掉第 5 步"

### 场景 5：Session Resume

1. 退出终端后重新进入，`/resume` 之前的 session
2. Plan Mode 状态（模式、待办、执行进度、讨论历史）全部恢复
3. 执行中的计划会从 session log 重建完成情况
4. 继续工作，如同从未中断

### 场景 6：快速查看

```bash
/plan       # 启用规划模式
<探索代码>   # 进行只读分析
/todos      # 查看当前待办
/plandiff   # 查看计划变更历史
/planqa     # 查看讨论上下文
/plan       # 退出规划模式
```

---

## 十二、修改与扩展示例

### 自定义安全规则

修改 `utils.ts` 中的 `DESTRUCTIVE_PATTERNS` 和 `SAFE_PATTERNS` 数组：

```typescript
// 添加 kubectl 只读命令到白名单
const SAFE_PATTERNS = [
  // ... 已有规则
  /^\s*kubectl\s+(get|describe|logs|top)/i,
];

// 或添加 docker 只读命令
  /^\s*docker\s+(ps|images|logs|inspect)/i,
```

### 自定义计划提取格式

修改 `extractTodoItems()` 中的正则，支持不同的标记格式：

```typescript
// 例如支持 Checklist 格式
// Checklist:
// - [ ] step one
// - [x] step two

const checklistPattern = /^\s*[-*]\s+\[\s*]\s+(.+)/gm;
```

### 添加新的状态机转换

在 `agent_end` 事件中添加新的 `ctx.ui.select()` 选项：

```typescript
// 在 agent_end 的选择处添加
const choice = await ctx.ui.select("Plan mode - what next?", [
  "Execute the plan (track progress)",
  "Stay in plan mode",
  "Refine the plan",
  "Save plan as template",  // 新增选项
]);
```

### 调试模式

可以添加日志输出来观察状态变化：

```typescript
pi.on("agent_end", async (event, ctx) => {
  console.log("[plan-mode] agent_end: planModeEnabled=%s executionMode=%s", 
    planModeEnabled, executionMode);
});
```

---

## 十三、Example 版与 Active 版比较

系统中有两个版本的 plan-mode：

| 特性 | Example 版 (390 行) | Active 版 (591 行) |
|------|-------------------|-------------------|
| 文件位置 | `packages/coding-agent/examples/extensions/plan-mode/` | `~/.pi/agent/extensions/plan-mode/` |
| 用途 | 教学示例，展示扩展开发基础 | 实际运行版本，功能完整 |
| Git 版本化 | 无 | 有 (savePlanIteration, git init/commit) |
| `/plandiff` | 无 | 有 |
| `/planqa` | 无 | 有 |
| `isPlanRevisionIntent` | 无 | 有 |
| Q&A 历史捕获 | 无 | 有 (`qaMessages`) |
| `planPresented` 追踪 | 无 | 有 |
| Q&A 历史捕获 | 无 | 有 (`qaMessages`) |
| 分级注入 | 无 | 有 (首轮 full/后续 short) |
| 条件触发选择 | 无 | 有 (todoHash 变化时弹出) |
| Q&A 自动清理 | 无 | 有 (max 6 条) |
| Token-budget 集成 | 无 | 有 (压力标签 + 用量记录) |
| 工具管理策略 | 保存/恢复自定义工具 (toolsBeforePlanMode) | 硬编码工具列表 (PLAN_MODE_TOOLS) |
| CLI flag 描述 | 英文 | 中文 |
| 语言 | 英文 | 中文 |

**Example 版的重要设计参考**：它展示了**工具保护模式**——在进入规划模式前保存 `pi.getActiveTools()`，退出时恢复，确保未受管理的第三方工具不被意外丢弃。

---

## 十四、待实现特性

以下功能已在构思和设计阶段，但尚未实现：

### 增强 TUI 审查界面
- 步骤在 TUI 中以可滚动列表展示（而非聊天消息）
- 每步状态图标（待处理 / 进行中 / 已完成）
- 键盘驱动操作：审批(a) 拒绝(r) 推迟(d) 跳过(s) 详情(S) 退出(q)
- 替代当前的 `select()` 行内提示

### LLM 变更摘要
- 计划执行完成后，agent 生成自然语言的变更摘要
- 包含：修改的文件、关键决策、与原计划的偏差
- 以结构化消息在聊天中展示

### 全局快捷键
- `/plandiff` 绑定全局快捷键（如 Ctrl+Alt+D）
- `/planqa` 绑定全局快捷键（如 Ctrl+Alt+Q）
- 快捷键在任何 mode 下都可用

---

## 十五、附录：安全命令白名单

### 允许的命令（安全）

| 类别 | 命令 |
|------|------|
| 文件查看 | `cat` `head` `tail` `less` `more` `wc` `sort` `uniq` `diff` `file` `stat` `du` `df` `tree` `which` `whereis` `type` |
| 搜索 | `grep` `find` `rg` `fd` `awk` `jq` `sed -n` |
| 目录 | `ls` `pwd` `lsblk` `eza` `bat` |
| 系统信息 | `uname` `whoami` `id` `date` `cal` `uptime` `free` `ps` `top` `htop` `env` `printenv` |
| Git 只读 | `git status` `git log` `git diff` `git show` `git branch` `git remote` `git ls-files` `git ls-tree` `git config --get` |
| 包信息 | `npm list/ls/view/info/search/outdated/audit` `yarn list/info/why/audit` |
| 版本 | `node --version` `python --version` |
| 网络 | `curl` `wget -O -` |
| 其他 | `echo` `printf` |

### 阻止的命令（不安全）

| 类别 | 命令 |
|------|------|
| 文件修改 | `rm` `rmdir` `mv` `cp` `mkdir` `touch` `chmod` `chown` `chgrp` `ln` `tee` `truncate` `dd` `shred` |
| Git 写入 | `git add` `git commit` `git push` `git pull` `git merge` `git rebase` `git reset` `git checkout` `git branch -d` `git stash` `git cherry-pick` `git revert` `git tag` `git init` `git clone` |
| 包安装 | `npm install/uninstall/update/ci/link/publish` `yarn add/remove/install/publish` `pnpm add/remove/install/publish` `pip install/uninstall` `apt install/remove/purge/update/upgrade` `brew install/uninstall/upgrade` |
| 系统操作 | `sudo` `su` `kill` `pkill` `killall` `reboot` `shutdown` `systemctl start/stop/restart/enable/disable` `service start/stop/restart` |
| 编辑器 | `vim` `nano` `emacs` `code` `subl` |
| 重定向 | `>` `>>` |
