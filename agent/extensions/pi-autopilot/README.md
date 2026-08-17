# pi-autopilot — 自主运行扩展

融合 pi-scheduler（定时任务）+ pi-admin（自管理）并增加失败自愈闭环，让 Pi 无人值守自驱动运行。

## 功能

### 1. 定时任务

| 类型 | 命令 | 说明 |
|------|------|------|
| interval | `/schedule loop 5m check build` | 固定间隔循环，创建后立即执行一次 |
| cron | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron |
| once | `/schedule remind +30m review PR` | 一次性提醒，执行后自动禁用 |

- 会话内：30s 轮询触发；离线：`pi-cron.sh` 由系统 cron 每分钟调用
- 任务属性：标签、历史记录、最大运行时间、重试次数、完成通知（Webhook）
- 导出/导入（JSON）、cron 表达式预览、模板变量 `{{date}}`/`{{time}}`/`{{datetime}}`/`{{cwd}}`

### 2. 失败自愈

| 错误类别 | 判定 | 处置 |
|---------|------|------|
| 超时 | exit 124 | 重试至耗尽，然后切备选模型 |
| 服务不可用 | provider/api/connection/network/429/503/502 等 | `failoverAfter`(2) 次后切换 fallback 链 |
| 逻辑错误 | Error:/invalid 等 | 直接失败（不烧重启成本） |
| 连续失败 | failCount ≥ `suspendAfter`(5) | 暂停任务 + Webhook 告警 |
| failover 熔断 | failoverCount ≥ `maxFailovers`(1) | 暂停任务——连续切换模型已达上限，防双模型链 ping-pong 无限重启（2026-08 审计修复） |
| 鉴权错误 | 401/403/unauthorized/invalid api key | 直接失败（重试无意义，不烧额度） |

- **模型 failover**：`fallbackModels` 硬白名单（AI 不可自由选模型），结合历史成功率选目标，写 wrapper 状态后重启带 `--model`
- **重试退避（A1，2026-08）**：失败重试延迟固定 60s 改为**指数退避 + 抖动**——`base 30s × 2^(failCount−1)`，上限 5min，±50% 抖动（下限 base/2）；连续瞬时故障（provider_down/超时）递增延迟避免自撞，抖动防共振
- **看门狗**：`maxIdleMinutes` 无活动自动重启恢复（`restart_hang`）；回合进行中（长工具执行）豁免——busy 期间不判挂死，但豁免有上限（2×maxIdleMinutes，turn 内真挂死不被永久豁免，2026-08 审计修复）
- **崩溃回滚**：pi-wrapper 连续 3 次崩溃 → 回滚 lastGood 模型（5 分钟防抖）
- **任务超时钳位**：调度任务 `maxRunTime` 钳位到 [5, 86400] 秒（负值/0 → 5s，≥2³¹ 溢出 → 86400），防极端值导致任务被立即误杀 / `maxCostPerDay`(0=不限) / `allowedModels`，超限自动跳过并通知（跳过时推进下次调度时间，预算恢复后自动补跑；不记 failed 遥测，避免 todayRuns 越拦越满锁到次日零点）
- **恢复队列（A2/A3，2026-08）**：
  - `pendingInject` 语义改为**运行中标记**——fireViaMessage 非阻塞（sendUserMessage 立即返回），tick 过滤 pendingInject=true 的任务防 interval 长任务重叠触发；`agent_settled`（主会话空闲）统一清除
  - 附带修复：旧实现注入后从不清除，崩溃恢复会重放全部历史注入任务；现只恢复真正"注入后未完成"的任务
  - **注入式任务最终化（finalizeInjected，2026-08-17 补闭环）**：agent_settled 时对本轮注入的 message 任务回写 `updateTaskAfterRun('success')`——once 任务自动删除（修复前 nextRun 推 +1h 而 computeNextRun 对 once 返回过期时间 → 每小时重复注入、永不删除）、interval/cron 推进 nextRun 并重置 failCount/failoverCount、`notifyOnCompletion` 补发 success webhook（与 subagent 路径对齐）、任务已删/改型安全跳过；`/schedule enable` 清零熔断计数（suspend 恢复后不一次失败即再熔断）
  - **恢复次数上限**：`recoveryCount` 超 3 次转 dead-letter——暂停任务 + Webhook 告警，需人工介入（`/schedule enable` 恢复），防连续崩溃无限重注入

### 3. 自管理

命令：`/auto restart`（重启需确认）
工具：`admin_status` `admin_list_models` `admin_set_model` `admin_list_sessions` `admin_switch_session` `admin_get_config` `admin_set_config` `admin_restart`

状态/统计：`/auto status [--stats]`（--stats 附加遥测统计） `/auto policy` `/auto failover [--exec]` `/auto pause` `/auto resume`（`/auto help` 查看全部用法）

> 精简说明：`/admin:model` `/admin:session` `/admin:config` 已移除（分别由内置 `/model`、`/resume` `/session` `/tree`、`/settings` 或模型侧 admin_* 工具替代）；`/loop` `/remind` 已并入 `/schedule loop|remind`。

**安全约束**：策略/预算配置仅 `/auto policy` 命令可写；`autopilot_policy` 工具只读；failover 链为配置白名单。

## 配置

`.pi-autopilot-config.json`（首次自动生成）：

```json
{
  "enabled": true,
  "requeueOnRestart": true,
  "maxIdleMinutes": 30,
  "budget": { "maxRunsPerDay": 50, "maxCostPerDay": 0, "allowedModels": [] },
  "policy": { "failoverAfter": 2, "suspendAfter": 5, "timeoutFactor": 2, "maxFailovers": 1 },
  "fallbackModels": []
}
```

运行时文件：`.pi-autopilot-telemetry.json`（1000 条上限）、`.pi-autopilot-lastgood.json`、`.pi-autopilot-crash.json`（均在 `agent/` 下）。

**调度锁**：`agent/scheduler.lock`（与 pi-cron 共享）——内容 `PID:时间戳`，24h 租约 TTL（进程存活但调度停摆/PID 复用时不永久占用，2026-08 审计修复）。

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
| `scheduler.ts` | 30s 轮询、触发、错误处置闭环 |
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
npx vitest run        # 102 用例：storage/notifications + policy/failover/budget/telemetry/queue/watchdog
```

## 升级说明

替换 `settings.json` 中 `extensions/pi-admin/index.ts` 与 `extensions/pi-scheduler/index.ts` 两条目为 `extensions/pi-autopilot/index.ts`（rebuild.sh 已自动处理）。工具 `admin_*`、`schedule_task` 全部保留；命令已精简（见上文）：仅保留 `/auto` 与 `/schedule`（`/loop` `/remind` 并入其子命令）。
