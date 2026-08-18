# pi-bg.sh — 后台 pi 任务

pi 执行长任务时前台 TUI 被占用，无法同时对话。`pi-bg.sh` 用 tmux detached 会话
跑 headless pi（`-p` 一次性 或 `--mode rpc` 长驻），让**前台会话保持可用**，
后台任务独立推进，互不阻塞。

## 为什么不会冲突（四件套隔离）

| 冲突点 | 双 TUI 实例的风险 | pi-bg.sh 的做法 |
|---|---|---|
| 会话文件 | 同 cwd 下 `-c` 续同一 JSONL → 双树交错损坏 | `--no-session`，后台零会话写入 |
| 扩展副作用 | pi-voice 启动清空录音 tmp、autopilot 调度锁、memory 写入、usage-diag | `--no-extensions`，后台不加载任何扩展 |
| 文件修改 | 两 agent 同时改同一文件 | 默认 `--tools read,ls,grep,bash` 只读集合 + 提示词只读约束；确需写操作用 `--rw` 并自行保证与前台分文件 |
| 模型切换 | settings.json last-writer-wins 互相覆盖 | 后台不切模型（`--no-extensions` 亦禁 `/model` 切换入口） |

> 若前台与后台必须同时写文件（如构建产物、同一仓库），用 `--rw` 时请：
> 分工明确（后台负责 A 目录/分支，前台负责 B），或后台只读、写操作全部回前台。

## 用法

```bash
# 一次性后台任务（跑完自动退出，日志留 EXIT=）
pi-bg.sh start <name> <prompt...>

# 完整工具集（可写文件，风险自负）
pi-bg.sh start --rw <name> <prompt...>

# 长驻 RPC 模式（可随时注入指令，适合"后台持续干活 + 前台聊天 + 随时指挥"）
pi-bg.sh rpc [--rw] <name>

# 注入指令
pi-bg.sh prompt <name> "新任务/问题"
pi-bg.sh steer <name> "改向：先做 X 再做 Y"

# 状态 / 日志 / 停止
pi-bg.sh status [name]        # 运行中 / 已结束(exit 码) + 日志尾部
pi-bg.sh log <name> [lines]   # 默认 50 行
pi-bg.sh stop <name>          # 停止（日志保留在 ~/.pi/logs/bg/<name>.log）
pi-bg.sh list
```

## 示例

```bash
# 后台跑全量回归，前台继续聊天
pi-bg.sh start regression "运行 bash ~/.pi/scripts/test-all.sh，逐项报告结果并分析失败项"

# 长驻后台 agent：随时派活
pi-bg.sh rpc helper
pi-bg.sh prompt helper "调研 ~/.pi/agent/extensions 目录结构，输出摘要"
pi-bg.sh steer helper "改为只统计每个扩展的 registerCommand 数量"
pi-bg.sh status helper
pi-bg.sh stop helper
```

## 约束与说明

- 工作目录默认当前目录，可用 `--cwd <dir>` 指定（注意：路径含单引号会破坏 tmux 命令，暂不支持）。
- 后台实例与前台共享 `settings.json`/`models.json`/`auth.json`（只读共享，安全）。
- RPC 模式默认只读工具集（无 edit/write），bash 工具仍可执行任意命令——只读约束为提示词级软约束。
- 日志在 `~/.pi/logs/bg/<name>.log`，tmux 会话名为 `pi-bg-<name>`（前台 pi 退出不会清理它）。
- `PI_BIN` 环境变量可指定 pi 可执行文件路径（缺省自动定位，与 pi-cron.sh 同策略）。
- 与 pi-autopilot 定时任务、pi-cron.sh 离线调度不冲突：后台实例 `--no-extensions` 不持有调度锁。
