# Pi 自动修复系统 - 快速指南

完整、权威的恢复说明见 [`agent/rescue/README.md`](../agent/rescue/README.md)。本文是 wrapper 脚本的入口摘要。

**概述**：
`pi-wrapper.sh` 崩溃时仅负责检查、分类、启动修复进程；实际修复操作由 pi 自身完成（要么用当前 pi 修外部问题，要么用源码缓存的 pi 修坏的 pi）。这样既避免了脚本误修复，又让用户能在 TUI 中看到修复过程。

**崩溃分类**：
- `transient`：临时性错误（API 5xx/429、网络超时、ECONNREFUSED 等），只需指数退避重试，不需要修复。
- `external`：pi 核心正常，问题在于外部因素（扩展/配置/依赖/权限/磁盘）。此时用当前 pi（`--no-extensions --no-skills`）作为修复者，读取崩溃日志并自行修复外部问题。
- `pi_self`：pi 核心自身损坏（dist 文件语法错误、缺失、核心模块依赖不匹配等）。此时用源码缓存中的 pi（已编译好的 dist）作为修复者，去修复坏的 pi。（修复过程同样由 pi 完成，wrapper 只负责启动。）

**恢复升级链**（新逻辑）：
1. **分类崩溃**：wrapper 用纯日志关键词判断 crash 类别（transient / external / pi_self），秒级完成，不启动 pi。
2. **启动修复 pi**：
   - 对 transient：直接指数退避重试（不启动修复 pi）。
   - 对 external：wrapper 启动当前 pi（`--no-extensions --no-skills`），传入修复指令让它读崩溃日志并修外部问题。（修复成功后重新启用被禁用的扩展。）
   - 对 pi_self：wrapper 先确认源码缓存的 pi 是否存在（不存在则尝试实时构建），再启动该 pi 作为修复者，让它修复坏的 pi。（修复成功后同样会重新启用扩展。）
3. **健康检查**：修复后 wrapper 执行健康检查（无扩展启动 + 扩展加载测试），通过则视为恢复成功；失败则尝试其他策略或升级。
4. **熔断器与重试**：连续失败达到阈值时触发熔断器，避免无限循环。

**原有恢复链（作为回退）**：
如果新逻辑的修复 pi 失败，wrapper 会回退到原有的细粒度恢复链，以保证兼容性：
```
L1: 精准恢复（针对具体崩溃类型）
  ↓ 失败
L2: 源码恢复（从 pi-source-cache 恢复 dist/）
  ↓ 失败
L3: 救援模式 pi（--no-extensions 启动）
  ↓ 失败
停止恢复，等待用户干预
```

**熔断器机制**：
- 触发条件：连续失败 5 次
- 冷却时间：30 分钟
- 状态文件：`~/.pi/data/circuit-breaker.json`
- 行为：熔断期间跳过恢复，等待冷却后自动重置

**健康检查**：
1. 快速检查：`pi --version`（验证 Node 可执行）
2. 模块加载：完整 CLI 初始化链（捕获 dist 损坏）
3. 扩展加载：验证扩展不会导致崩溃（仅在恢复 extension_fail 后）
4. 进程存活：检查 pi 进程是否正常运行
5. 磁盘空间：检查磁盘使用率（>90% 警告）

**配置校验**：
启动前自动校验：
- `settings.json` 格式有效性
- `models.json` 格式有效性
- `modes.json` 格式有效性
校验失败时自动从快照恢复。

**状态追踪**：
- 禁用扩展列表：`~/.pi/data/disabled-extensions.json`
- 熔断器状态：`~/.pi/data/circuit-breaker.json`
- 崩溃计数：24 小时窗口内连续崩溃次数

**同类型连续失败**：连续2次相同类型崩溃时，直接升级到 L4（源码恢复 + 救援模式）。

**恢复后处理**：
- 成功启动后自动重新启用被禁用的扩展
- 每次恢复后执行健康检查
- 指数退避重试避免快速循环
- 重置熔断器状态

**审计日志**：
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

**测试**：
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

**相关文件**：
- `pi-wrapper.sh` - 生命周期管理、崩溃恢复（新增分类与启动修复 pi 的逻辑）
- `pi-crash-analyzer.sh` - 崩溃类型分析器（新增 transient/external/pi_self 分类）
- `pi-recovery-audit.sh` - 审计日志模块
- `~/.pi/data/logs/recovery-audit.jsonl` - 审计日志
- `~/.pi/data/circuit-breaker.json` - 熔断器状态
- `~/.pi/data/disabled-extensions.json` - 禁用扩展列表