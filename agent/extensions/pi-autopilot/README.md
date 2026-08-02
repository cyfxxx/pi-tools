# pi-autopilot — 自主运行扩展

融合 pi-scheduler（定时任务）+ pi-admin（自管理）并增加失败自愈闭环，让 Pi 无人值守自驱动运行。

## 功能

### 1. 定时任务

| 类型 | 命令 | 说明 |
|------|------|------|
| interval | `/loop 5m check build` | 固定间隔循环，创建后立即执行一次 |
| cron | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron |
| once | `/remind +30m review PR` | 一次性提醒，执行后自动禁用 |

- 会话内：1s 轮询触发；离线：`pi-cron.sh` 由系统 cron 每分钟调用
- 任务属性：标签、历史记录、最大运行时间、重试次数、完成通知（邮件/Webhook）
- 导出/导入（JSON）、cron 表达式预览、模板变量 `{{date}}`/`{{time}}`/`{{model}}`/`{{provider}}`

### 2. 失败自愈

| 错误类别 | 判定 | 处置 |
|---------|------|------|
| 超时 | exit 124 | 重试至耗尽，然后切备选模型 |
| 服务不可用 | provider/api/connection/network/429/503/502 等 | `failoverAfter`(2) 次后切换 fallback 链 |
| 逻辑错误 | Error:/invalid 等 | 直接失败（不烧重启成本） |
| 连续失败 | failCount ≥ `suspendAfter`(5) | 暂停任务 + Webhook 告警 |

- **模型 failover**：`fallbackModels` 硬白名单（AI 不可自由选模型），结合历史成功率选目标，写 wrapper 状态后重启带 `--model`
- **看门狗**：`maxIdleMinutes` 无活动自动重启恢复（`restart_hang`）
- **崩溃回滚**：pi-wrapper 连续 3 次崩溃 → 回滚 lastGood 模型（5 分钟防抖）
- **预算**：`maxRunsPerDay`(50) / `maxCostPerDay`(0=不限) / `allowedModels`，超限自动跳过并通知
- **恢复队列**：任务注入时标记 `pendingInject`，异常中断重启后自动重注入

### 3. 自管理（pi-admin 兼容）

命令：`/admin:status` `/admin:model` `/admin:session` `/admin:config` `/admin:restart`
工具：`admin_status` `admin_list_models` `admin_set_model` `admin_list_sessions` `admin_switch_session` `admin_get_config` `admin_set_config` `admin_restart`

新增：`/auto:status` `/auto:stats` `/auto:policy` `/auto:failover [--exec]` `/auto:pause` `/auto:resume`

**安全约束**：策略/预算配置仅 `/auto:policy` 命令可写；`autopilot_policy` 工具只读；failover 链为配置白名单。

## 配置

`.pi-autopilot-config.json`（首次自动生成）：

```json
{
  "enabled": true,
  "requeueOnRestart": true,
  "maxIdleMinutes": 30,
  "budget": { "maxRunsPerDay": 50, "maxCostPerDay": 0, "allowedModels": [] },
  "policy": { "failoverAfter": 2, "suspendAfter": 5, "timeoutFactor": 2 },
  "fallbackModels": []
}
```

运行时文件：`.pi-autopilot-telemetry.json`（1000 条上限）、`.pi-autopilot-lastgood.json`、`.pi-autopilot-crash.json`（均在 `agent/` 下）。

## 数据流

```
任务触发 → 预算检查 → 注入执行 → 遥测记录
失败 → 错误分类 → 决策矩阵 → 重试 / failover（重启切换模型）/ 暂停告警
会话挂死 → 看门狗 → 重启恢复 → 恢复队列重注入
崩溃 ×3 → wrapper 回滚 lastGood → 重启
```

## 模块

| 文件 | 职责 |
|------|------|
| `scheduler.ts` | 1s 轮询、触发、错误处置闭环 |
| `policy.ts` | 错误分类 + 决策矩阵 |
| `failover.ts` | fallback 链选择/执行（成功率排序，dry-run） |
| `watchdog.ts` | 挂死检测与恢复 |
| `budget.ts` | 预算三锁 |
| `telemetry.ts` | 运行遥测与成本估算（读 models.json 价格） |
| `queue.ts` | pendingInject 标记与恢复队列 |
| `autoconfig.ts` | 自主配置读写（原子写） |
| `state.ts` / `config.ts` / `sessions.ts` / `notifications.ts` / `storage.ts` | 自管理/任务存储（pi-admin + pi-scheduler 迁移） |
| `tools.ts` / `commands.ts` | 工具与命令注册（admin_* 兼容别名） |

## 开发

```bash
npm install
npx vitest run        # 86 用例：storage/notifications + policy/failover/budget/telemetry/queue/watchdog
```

## 升级说明

替换 `settings.json` 中 `extensions/pi-admin/index.ts` 与 `extensions/pi-scheduler/index.ts` 两条目为 `extensions/pi-autopilot/index.ts`（rebuild.sh 已自动处理）。旧命令 `/admin:*`、`/loop`、`/remind`、`/schedule` 与工具 `admin_*`、`schedule_task` 全部兼容保留。
