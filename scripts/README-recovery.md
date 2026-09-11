# Pi 自动修复系统

## 概述

`pi-wrapper.sh` 内置崩溃检测与自动恢复机制，在 pi 进程异常退出时分析原因并尝试修复。

## 崩溃类型

| 类型 | 匹配模式 | 恢复策略 |
|------|---------|---------|
| `missing_module` | ERR_MODULE_NOT_FOUND | 重装缺失包 / 源码恢复 |
| `syntax_error` | SyntaxError (dist 文件) | 重跑 rebuild |
| `extension_fail` | Failed to load extension | 智能禁用 / 恢复 |
| `config_corrupt` | settings.json 损坏 | 快照恢复 / git 恢复 |
| `proxy_error` | 代理配置错误 | 清除代理变量 |
| `lock_contention` | EADDRINUSE / 锁竞争 | kill 竞争实例 |
| `provider_error` | 5xx / 429 / API 错误 | 指数退避重试 |
| `cli_argument_error` | Unknown option / invalid flag | 自动修复参数 |
| `network_error` | ECONNREFUSED / ETIMEDOUT | 指数退避重试 |
| `permission_error` | EACCES / permission denied | 修复文件权限 |
| `oom_error` | JavaScript heap out of memory | 清理内存 / 增加限制 |
| `disk_full` | ENOSPC / No space left on device | 清理磁盘空间 |
| `timeout_error` | 进程超时 / 挂死 | 强制终止并重启 |
| `unknown` | 未匹配类型 | 逐级升级策略 |

## 恢复升级链

```
L1: 精准恢复（针对具体崩溃类型）
  ↓ 失败
L2: 源码恢复（从 pi-source-cache 恢复 dist/）
  ↓ 失败
L3: 救援模式 pi（--no-extensions 启动）
  ↓ 失败
停止恢复，等待用户干预
```

## 熔断器机制

- **触发条件**：连续失败 5 次
- **冷却时间**：30 分钟
- **状态文件**：`~/.pi/data/circuit-breaker.json`
- **行为**：熔断期间跳过恢复，等待冷却后自动重置

## 健康检查

1. **快速检查**：`pi --version`（验证 Node 可执行）
2. **模块加载**：完整 CLI 初始化链（捕获 dist 损坏）
3. **扩展加载**：验证扩展不会导致崩溃（仅在恢复 extension_fail 后）
4. **进程存活**：检查 pi 进程是否正常运行
5. **磁盘空间**：检查磁盘使用率（>90% 警告）

## 配置校验

启动前自动校验：
- `settings.json` 格式有效性
- `models.json` 格式有效性
- `modes.json` 格式有效性

校验失败时自动从快照恢复。

## 状态追踪

- **禁用扩展列表**：`~/.pi/data/disabled-extensions.json`
- **熔断器状态**：`~/.pi/data/circuit-breaker.json`
- **崩溃计数**：24 小时窗口内连续崩溃次数

## 同类型连续失败

连续2次相同类型崩溃时，直接升级到 L4（源码恢复 + 救援模式）。

## 恢复后处理

- 成功启动后自动重新启用被禁用的扩展
- 每次恢复后执行健康检查
- 指数退避重试避免快速循环
- 重置熔断器状态

## 审计日志

位置：`~/.pi/data/logs/recovery-audit.jsonl`

```json
{
  "ts": 1788989712627,
  "crashCount": 1,
  "exitCode": 1,
  "crashType": "extension_fail",
  "snippet": "Failed to load extension...",
  "action": "extension_fail",
  "success": false,
  "durationMs": 291466,
  "detail": "恢复失败或健康检查不通过"
}
```

## 测试

```bash
# 测试崩溃分析器
bash pi-crash-analyzer.sh <crash_log_file>

# 查看审计日志
cat ~/.pi/data/logs/recovery-audit.jsonl | jq .

# 查看熔断器状态
cat ~/.pi/data/circuit-breaker.json | jq .

# 查看禁用扩展列表
cat ~/.pi/data/disabled-extensions.json
```

## 相关文件

- `pi-wrapper.sh` - 生命周期管理、崩溃恢复
- `pi-crash-analyzer.sh` - 崩溃类型分析器
- `pi-recovery-audit.sh` - 审计日志模块
- `~/.pi/data/logs/recovery-audit.jsonl` - 审计日志
- `~/.pi/data/circuit-breaker.json` - 熔断器状态
- `~/.pi/data/disabled-extensions.json` - 禁用扩展列表
