# pi-autopilot — 自主运行扩展

> 融合 pi-scheduler（定时任务）+ pi-admin（自管理）并增加失败自愈闭环，让 Pi 无人值守自驱动运行。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 定时任务、失败自愈、自管理 |
| 相关文档 | [pi-scheduler](../pi-scheduler/README.md), [pi-admin](../pi-admin/README.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、模块说明](#六模块说明)
- [七、数据流](#七数据流)
- [八、已知问题](#八已知问题)
- [九、测试](#九测试)
- [十、更新记录](#十更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 在无人值守场景下需要：
- 定时执行任务（如每日站会、定期检查）
- 自动处理失败（如 API 超时、服务不可用）
- 自管理（如重启、状态查看）

### 1.2 设计理念

- **融合架构**：将 pi-scheduler 和 pi-admin 合并为统一扩展
- **失败自愈**：自动分类错误，选择最合适的恢复策略
- **预算控制**：防止无限重试和成本失控
- **安全约束**：策略/预算配置仅命令可写，工具只读

---

## 二、架构

### 2.1 系统架构图

```
任务触发 → 预算检查 → 注入执行 → 遥测记录
    ↓
失败 → 错误分类 → 决策矩阵 → 重试 / failover / 暂停告警
    ↓
会话挂死 → 看门狗 → 重启恢复 → 恢复队列重注入
    ↓
崩溃 ×3 → wrapper 回滚 lastGood → 重启
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 调度器 | `scheduler.ts` | 30s 轮询、触发、错误处置闭环 |
| 策略引擎 | `policy.ts` | 错误分类 + 决策矩阵 |
| 模型切换 | `failover.ts` | fallback 链选择/执行（成功率排序，dry-run） |
| 看门狗 | `watchdog.ts` | 挂死检测与恢复 |
| 预算控制 | `budget.ts` | 预算三锁（maxRunsPerDay/maxCostPerDay/allowedModels） |
| 遥测 | `telemetry.ts` | 运行遥测与成本估算（读 models.json 价格） |
| 恢复队列 | `queue.ts` | pendingInject 标记与恢复队列 |
| 配置管理 | `autoconfig.ts` | 自主配置读写（原子写） |

### 2.3 事件流

1. **任务触发**：cron 轮询或手动触发
2. **预算检查**：检查是否超出运行次数/成本限制
3. **注入执行**：通过 sendUserMessage 注入任务
4. **遥测记录**：记录运行结果和成本
5. **失败处理**：错误分类 → 决策矩阵 → 重试/failover/暂停

---

## 三、功能

### 3.1 定时任务

| 类型 | 命令 | 说明 |
|------|------|------|
| interval | `/schedule loop 5m check build` | 固定间隔循环，创建后立即执行一次 |
| cron | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron |
| once | `/schedule remind +30m review PR` | 一次性提醒，执行后自动禁用 |

**特性**：
- 会话内：30s 轮询触发；离线：`pi-cron.sh` 由系统 cron 每分钟调用
- 任务属性：标签、历史记录、最大运行时间、重试次数、完成通知（Webhook）
- 导出/导入（JSON）、cron 表达式预览、模板变量 `{{date}}`/`{{time}}`/`{{datetime}}`/`{{cwd}}`

### 3.2 失败自愈

| 错误类别 | 判定 | 处置 |
|---------|------|------|
| 超时 | exit 124 | 重试至耗尽，然后切备选模型 |
| 服务不可用 | provider/api/connection/network/429/503/502 等 | `failoverAfter`(2) 次后切换 fallback 链 |
| 逻辑错误 | Error:/invalid 等 | 直接失败（不烧重启成本） |
| 连续失败 | failCount ≥ `suspendAfter`(5) | 暂停任务 + Webhook 告警 |
| failover 熔断 | failoverCount ≥ `maxFailovers`(1) | 暂停任务——连续切换模型已达上限 |
| 鉴权错误 | 401/403/unauthorized/invalid api key | 直接失败（重试无意义） |

**关键机制**：
- **模型 failover**：`fallbackModels` 硬白名单（AI 不可自由选模型），结合历史成功率选目标
- **重试退避**：指数退避 + 抖动——`base 30s × 2^(failCount−1)`，上限 5min，±50% 抖动
- **看门狗**：`maxIdleMinutes` 无活动自动重启恢复（默认 180 分钟）
- **崩溃回滚**：pi-wrapper 连续 3 次崩溃 → 回滚 lastGood 模型（5 分钟防抖）
- **任务超时钳位**：调度任务 `maxRunTime` 钳位到 [5, 86400] 秒

### 3.3 自管理

**命令**：
- `/auto restart`（重启需确认）
- `/auto status [--stats]`（--stats 附加遥测统计）
- `/auto policy`
- `/auto failover [--exec]`
- `/auto pause`
- `/auto resume`
- `/auto help`

**工具**（共 16 个）：
- `admin_*`（8 个）：admin_status, admin_list_models, admin_set_model, admin_list_sessions, admin_switch_session, admin_get_config, admin_set_config, admin_restart
- `autopilot_*`（5 个）：autopilot_status, autopilot_stats, autopilot_failover, autopilot_policy, schedule_task
- `verify_*`（3 个）：verify_report, verify_config, verify_test

**安全约束**：
- 策略/预算配置仅 `/auto policy` 命令可写
- `autopilot_policy` 工具只读
- failover 链为配置白名单

---

## 四、配置项

### 4.1 主配置文件

`.pi-autopilot-config.json`（首次自动生成）：

```json
{
  "enabled": true,
  "requeueOnRestart": true,
  "maxIdleMinutes": 180,
  "budget": { "maxRunsPerDay": 50, "maxCostPerDay": 0, "allowedModels": [] },
  "policy": { "failoverAfter": 2, "suspendAfter": 5, "timeoutFactor": 2, "maxFailovers": 1 },
  "fallbackModels": []
}
```

### 4.2 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 启用自主运行 |
| `requeueOnRestart` | boolean | true | 重启时重新入队任务 |
| `maxIdleMinutes` | number | 180 | 看门狗超时时间（分钟） |
| `budget.maxRunsPerDay` | number | 50 | 每日最大运行次数 |
| `budget.maxCostPerDay` | number | 0 | 每日最大成本（0=不限） |
| `budget.allowedModels` | string[] | [] | 允许的模型列表 |
| `policy.failoverAfter` | number | 2 | 失败多少次后切换模型 |
| `policy.suspendAfter` | number | 5 | 失败多少次后暂停任务 |
| `policy.timeoutFactor` | number | 2 | 超时因子 |
| `policy.maxFailovers` | number | 1 | 最大 failover 次数 |
| `fallbackModels` | string[] | [] | 备选模型列表 |

### 4.3 enabled 门控语义

`enabled=false`（自主运行关闭）时 30s tick 直接返回——到期任务不自动触发（含 waitForUserOnLocal 提示注入），预算检查也不执行；手动 `/schedule run`（含 force）不经 tick 门控，不受影响。

---

## 五、使用方法

### 5.1 安装

```bash
# 通过 rebuild.sh 自动安装
bash scripts/rebuild.sh --yes

# 或手动安装 cron
bash scripts/install/install-cron.sh

# 或安装 systemd timer
bash scripts/install/install-systemd.sh
```

### 5.2 基本用法

```bash
# 创建定时任务
/schedule loop 5m check build
/schedule cron "0 9 * * 1-5" standup
/schedule remind +30m review PR

# 查看状态
/auto status
/auto status --stats

# 查看策略
/auto policy

# 查看 failover 配置
/auto failover
```

### 5.3 高级用法

```bash
# 暂停/恢复任务
/auto pause
/auto resume

# 重启（需确认）
/auto restart

# 手动触发任务
/schedule run <task-id>
```

### 5.4 admin_restart 上下文提示

调用 `admin_restart` 时，若当前上下文 ≥40% 窗口（阈值硬编码 0.4），工具会发出 warning 通知并在返回值附带提示：重启后首轮将全量重发，建议先 `/compact` 再重启。

---

## 六、模块说明

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

---

## 七、数据流

```
任务触发 → 预算检查 → 注入执行 → 遥测记录
失败 → 错误分类 → 决策矩阵 → 重试 / failover（重启切换模型）/ 暂停告警
会话挂死 → 看门狗 → 重启恢复 → 恢复队列重注入
崩溃 ×3 → wrapper 回滚 lastGood → 重启
```

### 7.1 运行时文件

| 文件 | 说明 |
|------|------|
| `.pi-autopilot-telemetry.json` | 遥测数据（1000 条上限） |
| `.pi-autopilot-lastgood.json` | 最后一次成功运行的模型 |
| `.pi-autopilot-crash.json` | 崩溃记录 |
| `agent/extensions/pi-autopilot/scheduler.lock` | 调度锁（与 pi-cron 共享） |

### 7.2 调度锁

`agent/extensions/pi-autopilot/scheduler.lock`（与 pi-cron 共享）——内容 `PID:时间戳`，24h 租约 TTL（进程存活但调度停摆/PID 复用时不永久占用）。

---

## 八、已知问题

- **成本估算口径**：遥测 `estCost` 以 prompt/output 字符数近似 token 数（1 字符≈1 token，真实 usage 不可得）——对中文等多字节文本系统性偏松（低估），仅作相对趋势参考，非精确计费
- **上下文压缩建议**：调用 `admin_restart` 时，若当前上下文 ≥40% 窗口，工具会发出 warning 通知，建议先 `/compact` 再重启

---

## 九、测试

### 9.1 运行测试

```bash
cd agent/extensions/pi-autopilot
npm install
npx vitest run
```

### 9.2 测试覆盖

- storage/notifications
- scheduler
- policy/failover/budget/telemetry/queue/watchdog

---

## 十、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、架构图 |
| 2026-08-25 | v1.0 | 中止回合甄别——宿主 finally 无条件发 agent_settled |
| 2026-08-17 | v1.0 | admin_restart 高上下文压缩建议；finalizeInjected 注入式任务闭环 |
| 2026-08 | v1.0 | 重试改指数退避+抖动（A1）；恢复队列 pendingInject 重语义与崩溃恢复修复（A2/A3） |

---

## 十一、升级说明

替换 `settings.json` 中 `extensions/pi-admin/index.ts` 与 `extensions/pi-scheduler/index.ts` 两条目为 `extensions/pi-autopilot/index.ts`（rebuild.sh 已自动处理）。工具 `admin_*`、`schedule_task` 全部保留；命令已精简：仅保留 `/auto` 与 `/schedule`（`/loop` `/remind` 并入其子命令）。