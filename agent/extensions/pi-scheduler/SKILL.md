---
name: pi-scheduler
description: 定时任务扩展。支持 interval / cron / once 三种触发类型。会话内自动执行，离线时由系统 cron 唤醒 Pi 执行。用户说"定时""循环""提醒""调度""计划任务""每隔""每X分钟"时触发。
---

# pi-scheduler 技能

对 agent 暴露定时任务调度能力。Pi 会话活跃时由扩展内 30s 轮询引擎触发，Pi 关闭时由系统 cron 唤醒 Pi 执行。

## 命令列表

- [`/loop <interval> <prompt>`](#loop) — 创建间隔循环任务并立即执行
- [`/schedule [subcmd]`](#schedule) — 管理定时任务
- [`/remind <time> <prompt>`](#remind) — 创建一次性提醒

### `/loop`

创建间隔循环任务（创建后立即执行一次）。

| 参数 | 说明 |
|------|------|
| `interval` | 间隔时间：`30s` / `5m` / `1h` / `2d` |
| `prompt` | 要 agent 执行的提示词，支持模板变量 |
| `--timeout <秒>` | 执行超时（useSubagent 模式生效） |
| `--tags a,b` | 任务标签 |
| `--retries <n>` | 失败后额外重试次数（每次间隔 60s） |

**示例：**
- `/loop 5m 检查 CI 状态并报告未提交的变更`
- `/loop 1h 运行完整测试套件并总结`
- `/loop 30s 检查开发服务器是否仍在响应`
- `/loop 10m 检查构建状态 --timeout 600 --retries 2`
- `/loop 1h 汇报 {{date}} 的 git 提交`

### `/schedule`

管理定时任务。支持 cron、interval、once 三种类型。

| 子命令 | 说明 |
|--------|------|
| `list [--tag <t>]` | 列出所有任务（默认，可按标签过滤） |
| `edit <id或name> [--schedule <expr>] [--prompt <text>] [--timeout <秒>] [--retries <n>]` | 修改任务 |
| `delete <id或name>` | 删除任务 |
| `enable <id或name>` | 启用已禁用的任务 |
| `disable <id或name>` | 禁用任务 |
| `cron "<expr>" <prompt>` | 创建 cron 定时任务 |
| `test "<expr>"` | 预览未来 5 次触发时间 |
| `history <id或name>` | 查看最近 10 次执行记录 |
| `export` / `import <file>` | 导出 / 导入任务 JSON |
| `pause` / `resume` | 全局暂停 / 恢复调度 |

**cron 表达式（5 字段）：** `minute hour day-of-month month day-of-week`

| 表达式 | 说明 |
|--------|------|
| `0 9 * * 1-5` | 工作日 9:00 |
| `*/5 * * * *` | 每 5 分钟 |
| `0 0 * * *` | 每小时整点 |
| `30 4 * * 0` | 每周日 4:30 |

**示例：**
- `/schedule cron "0 9 * * 1-5" 每日早会：总结昨天的工作，列出今天的计划`
- `/schedule list`
- `/schedule delete loop-a1b2c3`

### `/remind`

创建一次性提醒任务，执行成功后自动移除。

| 参数 | 说明 |
|------|------|
| `time` | 相对时间 `+30m`，或 ISO 时间戳 `2026-07-15T09:00` |
| `prompt` | 要 agent 执行的提示词 |

**示例：**
- `/remind +30m 回顾今天的待办的优先级`
- `/remind 2026-07-15T09:00 处理 PR review`

## LLM 工具

### `schedule_task`

Agent 可在对话中自主调用此工具。

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `action` | `add`/`list`/`update`/`delete`/`enable`/`disable`/`pause`/`resume` | 是 | 操作 |
| `name` | string | 增删改时 | 任务名 |
| `taskId` | string | 增删改时 | 任务 ID（优先于 name） |
| `type` | `interval`/`cron`/`once` | add 时 | 任务类型 |
| `schedule` | string | add 时 | 调度表达式 |
| `prompt` | string | add 时 | 提示词 |
| `useSubagent` | boolean | 否 | 子代理执行 |
| `notifyOnCompletion` | boolean | 否 | 完成通知（在线与离线均生效） |
| `maxRunTime` | number | 否 | 执行超时秒数（默认 300，仅 useSubagent 生效） |
| `tags` | string[] | 否 | 任务标签 |
| `retries` | number | 否 | 失败后额外重试次数（默认 0） |

**场景示例：**

用户说"每隔 5 分钟检查一下构建状态"：
→ 调用 `schedule_task` action=add type=interval schedule=5m prompt="检查构建状态"

用户说"明天早上 9 点提醒我开会"：
→ 调用 `schedule_task` action=add type=once schedule="2026-07-15T09:00" prompt="开会时间到了"

## 离线执行

Pi 关闭时，系统 cron 每分钟执行 `pi-cron.sh`：

1. 检测到 Pi 不在运行（锁文件无存活 PID）
2. 读取 `scheduled-tasks.json`，找到到期任务
3. 以 print 模式运行 `pi -p "<prompt>"`
4. 更新任务状态，记录日志

下次进入 Pi 时，扩展会在会话顶部显示离线执行摘要：

```
━━━ 离线期间定时任务执行报告 ━━━
  ✓ morning-standup — success
  ✗ ci-check — failed
    [超时] 任务执行超过 300s
━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 任务生命周期

```
创建 (/loop /schedule /remind)
  → 校验表达式 + 重名校验 → 写入 scheduled-tasks.json
  → 计算 nextRun → 等待到期...
      ├── 会话内：30s 轮询 → 到期 → sendUserMessage
      └── 离线：cron 60s 间隔 → 到期 → pi -p
  → 更新 lastRun / lastResult / nextRun / history
  → 失败且配置 retries → 60s 后重试
  → 循环（interval/cron）或移除（once）
```

## 注意事项

1. **Pi 运行中时不会离线触发**：锁文件机制确保 cron 跳过 Pi 活跃期间的任务。
2. **`once` 任务只触发一次**：执行成功后自动移除；失败且配置重试则按重试计划执行。
3. **超时保护**：每个任务默认 `maxRunTime=300s`，可调整。
4. **任务迁移**：重建后任务文件保留（`scheduled-tasks.json` 非 git 跟踪），使用 `pi-backup` 备份。
5. **cron 表达式**：使用 5 字段 POSIX 格式，第 6 字段（秒）不支持；按系统本地时区计算。
6. **无效表达式与重名会被拒绝**：创建时校验，不会产生永不执行的任务。
7. **模板变量**：prompt 中 `{{date}}` `{{time}}` `{{datetime}}` `{{cwd}}` 会在执行时渲染。
