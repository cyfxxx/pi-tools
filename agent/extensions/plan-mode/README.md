# plan-mode — 只读探索与计划驱动的安全执行模式扩展

> 强制 agent **先充分理解代码，再动手修改**，提供安全性、可追踪性和可复盘性。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 代码分析、计划执行 |
| 相关文档 | [CHANGELOG.md](./CHANGELOG.md), [Pi 官方文档](https://pi.dev/) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、安全模型](#六安全模型)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

AI 编程助手在"先分析"还是"先动手"之间容易失控。

### 1.2 设计理念

- **Plan Mode（规划模式）** — 只读阶段，agent 只能分析和探索
- **Execution Mode（执行模式）** — 全权限阶段，agent 按照计划执行

三重保障：
- **安全性** — 防止 agent 过早做出破坏性操作
- **可追踪性** — 每一步的完成状态清晰可见
- **可复盘性** — 计划的每次迭代都被 git 版本化

---

## 二、架构

### 2.1 系统架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                      plan-mode 扩展                              │
│                                                                  │
│  index.ts        # 主入口：事件绑定 + 命令注册 + 状态机           │
│  state.ts        # 类型定义 + 纯 reducer + 状态转换校验          │
│  store.ts        # 模块级状态单元                                │
│  selectors.ts    # 纯选择器（visibleTasks/tasksByStatus 等）     │
│  view.ts         # 格式化：彩色图标、状态标签                     │
│  overlay.ts      # TodoOverlay 悬浮层                            │
│  todo.ts         # todo 工具 + /plan todos 命令注册              │
│  utils.ts        # 纯函数：安全命令检查、Plan 提取、修订检测     │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 核心状态变量

```typescript
let planModeEnabled = false;    // 是否处于规划模式（只读）
let executionMode = false;      // 是否处于执行模式（全权限）
let planPresented = false;      // 是否已展示计划（防误覆盖）
let planDir: string | null = null; // 当前计划的 git 版本库路径
let qaMessages: QAPair[] = [];  // 与该计划相关的 Q&A 讨论历史
```

### 2.3 两阶段状态机

```
                         ┌──────────────────┐
                         │   Normal Mode     │
                         │  (全工具可用)      │
                         └────────┬─────────┘
                                  │ /plan 或 --plan
                                  ▼
              ┌──────────────────────────────────────┐
              │          Plan Mode                   │
              │         (只读探索阶段)                 │
              │  可用工具 (11 个):                     │
              │    read / bash / grep / find / ls     │
              │    todo / web_search / fetch_url      │
              │    subagent / plan_exit / ask_user    │
              └──────────────────┬───────────────────┘
                                 │ Agent 输出 Plan: 后
                                 ▼
              ┌──────────────────────────────────────┐
              │     用户选择 (agent_end 事件触发)       │
              │  ① Execute the plan → 切换执行模式    │
              │  ② Stay in plan mode → 停留规划模式   │
              │  ③ Refine the plan → 精炼计划         │
              └──────────────────┬───────────────────┘
                                 │ 选择 "Execute"
                                 ▼
              ┌──────────────────────────────────────┐
              │       Execution Mode                 │
              │      (全权限执行阶段)                   │
              │  全部完成 → 自动回到 Normal Mode        │
              └──────────────────────────────────────┘
```

---

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `todo` | `action`, `subject?`, `id?`, `status?`, `description?`, `activeForm?`, `includeDeleted?` | 管理计划任务列表 |
| `ask_user` | `question`, `header?`, `options`, `multiple?` | 向用户提问并获取选择回答 |

### 3.2 命令清单

| 命令 | 描述 |
|------|------|
| `/plan` | 无参切换规划模式（只读探索） |
| `/plan enter` | 启用规划模式 |
| `/plan exit` | 退出规划模式（任务保留） |
| `/plan help` | 输出全部子命令用法 |
| `/plan todos` | 按状态分组显示所有计划任务 |
| `/plan view` | 显示当前版本计划全文；`--diff` 显示差异；`--qa` 显示问答历史 |
| `/plan clear` | 清空所有计划任务（手动重置） |
| `/plan resume` | 恢复执行模式，继续未完成的计划 |

### 3.3 快捷键

| 快捷键 | 操作 |
|--------|------|
| `Ctrl+Alt+P` | 切换规划模式 |

### 3.4 CLI 参数

| 参数 | 描述 |
|------|------|
| `--plan` | 以规划模式启动（只读） |

### 3.5 Todo 状态机

- `pending → in_progress → completed`
- `pending / in_progress → blocked`（步骤被阻塞）
- `blocked → pending / in_progress / completed / deleted`（阻塞解决后恢复）
- `completed → deleted`（归档）

### 3.6 计划提取

Agent 在规划模式下按以下格式输出计划：

```
Plan:
1. 分析当前实现代码
2. 编写新的配置文件
3. 添加单元测试
```

### 3.7 会话持久化

所有状态（模式、待办、执行状态等）在 session resume 后完整恢复。

---

## 四、配置项

### 4.1 文件结构

```
~/.pi/agent/extensions/plan-mode/
├── index.ts        # 主入口：事件绑定 + 命令注册 + 状态机
├── state.ts        # 类型定义 + 纯 reducer + 状态转换校验
├── store.ts        # 模块级状态单元
├── selectors.ts    # 纯选择器
├── view.ts         # 格式化：彩色图标、状态标签
├── overlay.ts      # TodoOverlay 悬浮层
├── todo.ts         # todo 工具 + /plan todos 命令注册
├── utils.ts        # 纯函数：安全命令检查、Plan 提取
├── README.md       # 说明文档
└── CHANGELOG.md    # 变更日志
```

---

## 五、使用方法

### 5.1 基本用法

```bash
# 以规划模式启动
pi --plan

# 进入规划模式
/plan enter

# 退出规划模式
/plan exit

# 恢复执行模式
/plan resume

# 查看当前计划
/plan view

# 查看计划差异
/plan view --diff

# 查看讨论历史
/plan view --qa

# 查看待办列表
/plan todos
```

### 5.2 使用场景示例

**场景 1：新功能开发**

```bash
pi --plan   # 以规划模式启动
```

1. 在规划模式中询问 agent："分析现有代码，为添加用户管理系统制定计划"
2. Agent 提出澄清问题、执行影响分析
3. Agent 输出编号计划
4. 查看计划，如果满意选择 "执行计划（追踪进度）"
5. Agent 逐步执行，使用 `todo update` 标记完成步骤
6. 全部完成后自动提示

**场景 2：使用 todo 工具精细控制**

```bash
# 新建任务
todo create subject="实现登录功能"

# 标记开始
todo update id=1 status=in_progress activeForm="正在编写代码"

# 标记完成
todo update id=1 status=completed

# 标记阻塞
todo update id=1 status=blocked activeForm="依赖缺失"

# 查看所有任务
todo list

# 查看任务详情
todo get id=1
```

**场景 3：执行中修订计划**

执行模式中，若用户明确要求修改计划，LLM 会输出新的 `Plan:` 块：
- 已完成的步骤**保留**，未完成任务被替换为新提取的步骤
- 聊天中显示"计划已修订"

**场景 4：暂停与恢复**

- `/plan` 退出规划模式时**保留**任务与执行进度
- `/plan clear` 手动清空全部任务
- `/plan resume` 从保留的任务恢复执行模式

---

## 六、安全模型

### 6.1 Bash 白名单

只允许白名单中的纯读取 bash 命令：

| 类别 | 命令 |
|------|------|
| 文件查看 | `cat` `head` `tail` `less` `more` `wc` `sort` `uniq` `diff` `file` `stat` `du` `df` `tree` |
| 搜索 | `grep` `find` `rg` `fd` `awk` `jq` `sed -n` |
| 目录 | `ls` `pwd` `which` `whereis` `type` |
| 系统信息 | `uname` `whoami` `id` `date` `uptime` `free` `ps` `top` `htop` `cal` |
| Git 只读 | `git status` `git log` `git diff` `git show` `git branch` `git remote` |
| 包信息 | `npm list/ls/view/info/search/outdated/audit` |
| 网络 | `curl` `wget -O -` |
| 其他 | `echo` `printf` `node --version` `python --version` |

### 6.2 安全设计要点

1. **双重检查**：防止单一规则遗漏
2. **Git 读/写分离**：`git status` 允许，`git push` 禁止
3. **重定向保护**：仅允许尾部 `2>/dev/null`
4. **复合命令限制**：仅放行 `cd <dir> && <单条白名单命令>`

### 6.3 只读工具集

在规划模式中，只允许以下 11 个工具：
- `read` `bash` `grep` `find` `ls`
- `todo` `web_search` `fetch_url`
- `subagent` `plan_exit` `ask_user`

---

## 七、已知问题

- **追问保护**：Agent 已展示计划后，普通追问（why/what）不会误覆盖计划
- **条件触发选择**：计划未变化时自动跳过三选一，避免打断正常 Q&A
- **Q&A 自动清理**：讨论历史超过 6 条（3 轮）时自动裁剪

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/plan-mode
npm test
```

### 8.2 测试覆盖

- 状态转换校验
- 安全命令检查
- 计划提取和修订检测
- Todo 工具操作
- 会话持久化和恢复

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现只读探索与计划驱动的安全执行模式 |

---

## 十、Example 版与 Active 版比较

| 特性 | Example 版 (390 行) | Active 版 (591 行) |
|------|-------------------|-------------------|
| 文件位置 | `packages/coding-agent/examples/extensions/plan-mode/` | `~/.pi/agent/extensions/plan-mode/` |
| 用途 | 教学示例 | 实际运行版本 |
| Git 版本化 | 无 | 有 |
| `/plan view --diff` | 无 | 有 |
| `/plan view --qa` | 无 | 有 |
| 分级注入 | 无 | 有 |
| Token-budget 集成 | 无 | 有 |

---

## 十一、待实现特性

- **增强 TUI 审查界面**：步骤在 TUI 中以可滚动列表展示
- **LLM 变更摘要**：计划执行完成后生成自然语言变更摘要
- **全局快捷键**：`/plan view --diff` 和 `/plan view --qa` 绑定全局快捷键