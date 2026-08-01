# pi-scheduler

Pi 定时任务扩展。按指定时间或间隔自动运行 agent 执行预设任务。Pi 会话活跃时通过扩展内调度引擎执行，Pi 关闭时由系统 cron 唤醒 Pi 执行。

## 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│  会话内（Pi 运行中）                                                 │
│  extension scheduler.ts (30s 轮询) → 到期 → sendUserMessage / pi -p 子进程│
│  共享存储: agent/scheduled-tasks.json                                 │
│  锁文件: agent/scheduler.lock (PID)                                   │
├─────────────────────────────────────────────────────────────────────┤
│  离线（Pi 已关闭）                                                    │
│  系统 cron (每分钟) → scripts/pi-cron.sh                               │
│    → 锁检测（Pi 运行中则跳过）                                          │
│    → 读任务 JSON，找到期任务                                             │
│    → timeout <maxRunTime> pi -p "<prompt>"                             │
│    → 更新 lastRun / nextRun                                           │
│    → 写日志到 logs/scheduler/<name>-<ts>.log                           │
│    → 可选邮件 / webhook 通知                                           │
├─────────────────────────────────────────────────────────────────────┤
│  会话恢复                                                             │
│  session_start → 读未读日志 → TUI 显示离线执行摘要                      │
└─────────────────────────────────────────────────────────────────────┘
```

## 触发类型

| 类型 | 命令示例 | 说明 |
|------|----------|------|
| `interval` | `/loop 5m check CI` | 固定间隔重复，创建后立即执行一次 |
| `cron` | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron 表达式 |
| `once` | `/remind +30m review PR` | 一次性提醒，执行成功后自动移除 |

## 文件结构

```
agent/extensions/pi-scheduler/
├── index.ts              — 入口：扩展注册 + session_start/shutdown 钩子
├── storage.ts            — JSON 原子读写 + PID 锁 + 任务 CRUD + nextRun 计算
├── scheduler.ts          — 会话内 30s 轮询调度引擎
├── commands.ts           — /loop /schedule /remind 斜杠命令
├── tools.ts              — schedule_task LLM 工具
├── notifications.ts      — 离线执行日志收集与摘要展示
├── types.ts              — 类型定义
├── package.json          — 依赖：croner
├── README.md             — 本文件
└── SKILL.md              — 供 LLM 交互的技能定义

~/.pi/scripts/
├── pi-cron.sh            — cron 包装脚本（离线执行）
├── install-cron.sh       — 安装 crontab 条目（每分钟）
└── install-systemd.sh    — 安装 systemd timer

agent/scheduled-tasks.json — 任务持久化存储（扩展与 cron 共享，非 git 跟踪）
~/.pi/logs/scheduler/       — 离线执行日志（按任务名+时间戳归档）
```

## 安装

已在 `rebuild.sh` 中集成。只需：

```bash
bash scripts/rebuild.sh --yes
```

或手动：

```bash
cd agent/extensions/pi-scheduler && npm install
bash scripts/install-cron.sh   # 安装 crontab
```

## 命令

### `/loop <interval> <prompt>`

创建间隔循环任务并立即执行一次。

| 参数 | 说明 |
|------|------|
| `interval` | 间隔时间，支持 `30s`、`5m`、`1h`、`2d` |
| `prompt` | 任务提示词，支持模板变量（见下） |
| `--timeout <秒>` | 执行超时（仅 useSubagent 模式生效） |
| `--tags a,b` | 任务标签，用于 list 过滤 |
| `--retries <n>` | 失败后的额外重试次数（每次间隔 60s） |

```
/loop 5m check CI status and report uncommitted changes
/loop 1h run the full test suite and summarize
/loop 10m check build --timeout 600 --retries 2   # 超时 600s + 失败重试 2 次
/loop 30m check disk --tags infra,daily
```

### `/remind <time> <prompt>`

创建一次性提醒任务，执行成功后自动移除。

| 参数 | 说明 |
|------|------|
| `time` | 相对时间 `+30m`，或 ISO 时间戳 `2026-07-15T09:00` |
| `prompt` | 任务提示词 |

```
/remind +30m review open PRs
/remind 2026-07-15T09:00 morning standup
```

### `/schedule [subcommand]`

管理定时任务。

```
/schedule                          — 列出所有任务
/schedule list [--tag <t>]         — 列出所有任务（可按标签过滤）
/schedule edit <id> [--schedule <expr>] [--prompt <text>] [--timeout <秒>] [--retries <n>] — 修改任务
/schedule delete <id>              — 删除任务
/schedule enable <id>              — 启用任务
/schedule disable <id>             — 禁用任务
/schedule cron "<expr>" <prompt> [--timeout <秒>] [--tags a,b] [--retries <n>] — 创建 cron 任务
/schedule test "<expr>"            — 预览未来 5 次触发时间
/schedule history <id>             — 查看任务执行历史（最近 10 次）
/schedule export                   — 导出全部任务到 JSON 文件
/schedule import <file>            — 从 JSON 文件导入任务（重名/无效自动跳过）
/schedule pause                    — 全局暂停调度（在线与离线均跳过执行）
/schedule resume                   — 恢复调度
```

**cron 表达式格式：** 5 字段 `minute hour day-of-month month day-of-week`

| 示例 | 说明 |
|------|------|
| `0 9 * * 1-5` | 工作日 9:00 |
| `*/5 * * * *` | 每 5 分钟 |
| `0 0 * * *` | 每小时的整点 |
| `0 0 1 * *` | 每月 1 日 0:00 |
| `30 4 * * 0` | 每周日 4:30 |

> **时区说明：** cron 表达式按**系统本地时区**计算（扩展与离线脚本一致），存储格式统一为 ISO 时间戳。

## 模板变量

任务 `prompt` 支持以下模板变量，在每次执行时渲染：

| 变量 | 示例 |
|------|------|
| `{{date}}` | `2026-08-01` |
| `{{time}}` | `13:45:00` |
| `{{datetime}}` | `2026-08-01T13:45:00.000Z` |
| `{{cwd}}` | 执行进程的工作目录 |

```
/loop 1h send a summary of {{date}} git commits
```

## 失败重试

任务可配置 `retries`（失败后的额外尝试次数，每次间隔 60s）：

```
/loop 5m check deploy --retries 3
/schedule cron "0 9 * * 1-5" standup --retries 1
schedule_task action=add ... retries=2
```

- 重试期间 `runCount` 不增加，`failCount` 累计
- 成功即清零 `failCount`；重试耗尽仍失败则 `runCount` +1，进入正常调度

## 全局暂停

`/schedule pause` / `/schedule resume` 或 `schedule_task action=pause|resume` 可全局暂停/恢复调度（在线 30s 轮询与离线 cron 均跳过）。暂停期间 `nextRun` 不漂移，恢复后到期任务立即补执行。

## LLM 工具

### `schedule_task`

允许 agent 在对话中自主创建和管理定时任务。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `action` | `add` / `list` / `update` / `delete` / `enable` / `disable` / `pause` / `resume` | 是 | 操作类型 |
| `name` | string | 依赖 action | 任务名称 |
| `taskId` | string | update/delete/enable/disable 可用 | 任务 ID（优先于 name） |
| `type` | `interval` / `cron` / `once` | action=add 时必需 | 任务类型 |
| `schedule` | string | action=add 时必需 | 调度表达式（update 时可修改） |
| `prompt` | string | action=add 时必需 | 任务提示词（update 时可修改） |
| `useSubagent` | boolean | 否 | 是否在子代理中执行 |
| `notifyOnCompletion` | boolean | 否 | 完成时是否发送 webhook 通知（在线与离线均生效） |
| `maxRunTime` | number | 否 | 执行超时秒数（默认 `300`），仅 `useSubagent=true` 时生效 |
| `tags` | string[] | 否 | 任务标签（用于 list 过滤） |
| `retries` | number | 否 | 失败后的额外重试次数（默认 0） |

## 任务存储

任务文件 `agent/scheduled-tasks.json` 格式（`version: 2`，v1 数据自动迁移）：

```json
{
  "version": 2,
  "settings": {
    "mailTo": "",
    "webhookUrl": "",
    "defaultMaxRunTime": 300,
    "paused": false
  },
  "tasks": [{
    "id": "uuid",
    "name": "task-name",
    "type": "cron",
    "schedule": "0 9 * * 1-5",
    "prompt": "morning standup",
    "enabled": true,
    "lastRun": "2026-07-14T09:00:00Z",
    "lastResult": "success",
    "lastOutput": "...",
    "nextRun": "2026-07-15T09:00:00Z",
    "useSubagent": false,
    "notifyOnCompletion": false,
    "maxRunTime": 300,
    "runCount": 1,
    "history": [{
      "time": "2026-07-14T09:00:00Z",
      "result": "success",
      "output": "...",
      "durationMs": 45210
    }],
    "tags": ["daily"],
    "retries": 0,
    "failCount": 0,
    "createdAt": "2026-07-13T12:00:00Z",
    "updatedAt": "2026-07-14T09:00:00Z"
  }]
}
```

- `history`：最近 10 次执行记录（时间/结果/输出/耗时）
- `settings.webhookUrl` / `settings.mailTo`：通知配置（在线扩展与离线脚本共用；环境变量 `PI_SCHEDULER_WEBHOOK` / `PI_SCHEDULER_MAIL_TO` 优先）
- `settings.paused`：全局暂停标志（`/schedule pause` 设置）

### 创建校验

- 无效调度表达式（如错误的 cron、无法解析的时间）**创建即被拒绝**，不会产生永远不执行的任务
- 任务名不允许重复

## 离线执行（系统 cron）

### crontab

每分钟由 `cron daemon` 调用 `pi-cron.sh`：

```bash
* * * * * /path/to/pi-cron.sh
```

安装：

```bash
bash scripts/install-cron.sh
```

### systemd timer（备选）

```bash
bash scripts/install-systemd.sh
```

### 执行流程

1. `check_lock()` — 读 `scheduler.lock`，如果 PID 存活说明 Pi 在线，跳过
2. `acquire_lock()` — 抢占式 PID 锁，防止 cron 自身并发
3. `find_due_tasks()` — 读 JSON，找 `enabled=true` 且 `nextRun <= now` 的任务（`settings.paused` 时跳过）
4. `timeout <maxRunTime> pi -p "<prompt>"` — print 模式执行（渲染模板变量，统计耗时）
5. `update_task()` — 更新 lastRun / lastResult / nextRun / history，once 成功自动移除，失败按 retries 重试
6. `write_log()` — 写入 `logs/scheduler/<name>-<ts>.log`
7. `send_notification()` — 邮件或 webhook（可选，配置同在线通道）

### 锁机制

```
scheduler.lock (PID plain text)
├── 扩展 session_start → 写入当前 PID
├── 扩展 session_shutdown → 删除锁文件
├── cron check_lock → 读锁文件，kill -0 检查 PID
└── 僵死 PID → 自动清理（cron 发现 PID 不存活则删锁并继续）
```

### 通知

| 方式 | 配置 | 说明 |
|------|------|------|
| 日志文件 | 始终启用 | `logs/scheduler/<name>-<ts>.log` |
| 会话摘要 | 始终启用 | 下次进入 Pi 时 TUI 显示 |
| 邮件 | `settings.mailTo` 或 `PI_SCHEDULER_MAIL_TO` 环境变量 + `mail` 命令 | 任务配置 `notifyOnCompletion=true` 时发送 |
| Webhook | `settings.webhookUrl` 或 `PI_SCHEDULER_WEBHOOK` 环境变量 | POST JSON payload，在线与离线均生效 |

## 验证

`rebuild.sh` 验证步骤包含：

- pi-scheduler npm 包已安装
- crontab 或 systemd timer 已配置
- 任务 JSON 格式有效性
- 锁文件机制正确

## 常见问题

### 离线任务没有执行

**可能原因：** cron daemon 未运行。检查：

```bash
service cron status
```

### 任务执行超时

`maxRunTime` 默认 300s。可通过任务配置调整：

```bash
# 创建任务时指定（useSubagent 模式）
/loop 10m check build --timeout 600
/schedule cron "0 9 * * 1-5" standup --timeout 600
# LLM 工具参数
schedule_task action=add ... useSubagent=true maxRunTime=600
```

### 同一任务被重复触发

PID 锁机制防止双发。如果锁文件残留，手动清理：

```bash
rm -f agent/scheduler.lock
```

### `pi -p` 无法连接 provider

离线执行需要有 provider 后端运行。若使用 `local-llama`，确保 llama.cpp 服务在后台运行。

### 任务丢失（重启后）

任务存储在 `scheduled-tasks.json`（非 git 跟踪，已加入 `.gitignore`）。使用 `pi-backup` 备份时该文件已包含。

## 兼容性

| 扩展 | 关系 |
|------|------|
| pi-web-search / pi-browser | 无冲突。调度任务可调用 web_search 等工具。 |
| plan-mode | 无冲突。调度注入的用户消息不触发 plan-mode 的 tool_call 拦截。 |
| subagent | 无直接依赖。任务设 `useSubagent=true` 时以独立 `pi -p <prompt>` 子进程执行（非 subagent 扩展工具）。 |
| pi-backup | 备份清单包含 `scheduled-tasks.json` 和所有脚本。 |
