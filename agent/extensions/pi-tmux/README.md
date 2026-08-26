# pi-tmux

tmux 集成扩展：让 Pi 的 LLM 智能使用 tmux 管理持久后台任务。

## 解决的问题

Pi 内建 `bash` 工具是**非交互管道**（无 TTY、带 timeout/abort）——长任务（dev server、watch、build）、交互程序、TUI 程序要么输出被截断要么会话中断。`pi-tmux` 用 tmux 提供：

- **持久 TTY 会话**：`tmux new-session -d` 创建 detached 会话，不依赖当前终端存活
- **输出落盘**：`pipe-pane -o` 把 pane 输出持续写入 `~/.pi/logs/tmux/<会话>.log`，读取走日志尾部，稳定不丢历史
- **交互**：`send-keys` 注入文本 / Ctrl 组合键（如中断运行中的任务）
- **等待语义**：`wait` 轮询直到会话退出 / 日志出现关键字
- **生命周期**：会话统一 `pi-` 前缀；pi 退出时自动清理本扩展创建的会话（绝不触碰用户会话 main/work 等）

## 工具

| 工具 | 功能 |
|------|------|
| `tmux_run` | 在 detached tmux 会话执行命令，输出落盘日志；`notify`（布尔，默认 true）任务结束自动触发新回合汇报 |
| `tmux_status` | 列出所有 tmux 会话（含用户会话），标注附加状态 |
| `tmux_read` | 读取会话最近输出（日志尾部 N 行，缺失回退 capture-pane） |
| `tmux_send` | 向会话发送文本/回车/Ctrl 组合键 |
| `tmux_stop` | 结束会话，可选删除日志 |
| `tmux_wait` | 等待会话结束 / 日志出现 pattern / 超时 |

## 会话名约束与安全

- 会话名仅允许字母/数字/`_`/`-`（≤40 字符），非法名（含路径分隔符如 `../`）一律拒绝返回错误——防会话名路径穿越（曾存在 `tmux_stop(name='../../x')` 可 taskkill 任意 PID 的漏洞）
- Windows 原生后端：`bash -c` 启动的会话无交互 shell，`tmux_send` 文本输入被拦截不积压（Ctrl 组合键仍可中断）；会话可注入任意命令但需自行构造

## 用法示例

```bash
# 启动长任务（不阻塞对话）；任务结束自动触发新回合汇报（默认 notify=true，
# 无需手动查看——主会话被唤醒后用 tmux_read 收尾；notify=false 可关闭）
tmux_run(name="build", command="npm run build --watch")

# 读进度
tmux_read(name="build", lines=50)

# 等日志出现成功关键字
tmux_wait(name="build", pattern="Compiled successfully", timeout=300)

# 中断运行中的任务
tmux_send(name="build", ctrl_key="c")

# 交互输入
tmux_send(name="build", text="n", enter=true)

# 收尾
tmux_stop(name="build", remove_log=true)
```

## 完成自动唤醒

`tmux_run` 启动会话后轮询 `tmux has-session`（5s），会话消失即视为完成，经 `pi.sendMessage({customType:'pi-tmux-notify'},{triggerTurn:true})` 注入通知并触发新回合——后台任务结束后主会话自动被唤醒查看结果并收尾，无需用户发消息。

**会话结束语义**（`core.ts` 注入命令尾部追加 `; [ $? -ne 130 ] && exit`）：命令自然结束（成功或失败）时 shell 退出、会话结束——唤醒依赖此判定；退出码 130（SIGINT 中断，如 `tmux_send ctrl_key="c"`）保留 shell，维持"中断后继续交互"的用法（dev server 重启工作流）；长驻命令（dev server/watch）永不执行到退出语句，会话持续保留。命令结束后日志文件仍存在，`tmux_read` 照常读取。

风险防范：同会话只通知一次（去重）；定时器 `unref` + `session_shutdown` 时 `stopAll` 清理；同名重复注册覆盖旧监听器（notified/acked 标记一并清除）；`hasSession` 探测失败保守判存活（防 tmux 抖动误报完成）；通知失败静默；通知文本无时间戳（缓存友好）；`notify=false` 不注册监听；沿用已有会话（`started=false`，即同名会话已存在）不注册。实现见 `watcher.ts`（依赖注入纯逻辑，测试 `tests/watcher.test.ts`）。

防积压（待办 2026-08-19：批量完成通知延迟 40-100min 冗余报警）：①**同批合并**——完成事件先入 pending 队列，`MERGE_WINDOW_MS`（5s = 轮询间隔）固定窗口从首个完成起算，窗口内到期的会话合成一条汇总通知（同轮批量任务完成不再 N 条各自 sendMessage 积压）；②**消费标记**——`tmux_read` 成功读取后 `watcher.ack(name)`，该会话完成时不再通知（已人工查看过，含已入 pending 未 flush 的直接移除）；③**主动停止丢弃**——`tmux_stop` 的 `stop()` 丢弃该会话 pending 条目，防轮询竞态触发空通知。限制：harness 侧"回合进行中 triggerTurn 排队、下条用户消息才 flush"与积压消息过期均无法从扩展侧改变（sendMessage 后不可撤回），扩展侧只做合并降冗 + 已消费免打扰。

## 配置

`~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）：

```json
{
  "pi-tmux": {
    "bin": "tmux",
    "prefix": "pi-",
    "logDir": "~/.pi/logs/tmux",
    "defaultLines": 100,
    "defaultTimeoutSec": 120
  }
}
```

> 配置段名 `"pi-tmux"` 与别名 `"tmux"` 均可（config.ts 双键识别）。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_TMUX_BIN` | tmux 可执行文件路径 | `tmux` |
| `PI_TMUX_PREFIX` | 会话名前缀 | `pi-` |
| `PI_TMUX_LOG_DIR` | 日志目录 | `~/.pi/logs/tmux` |
| `PI_TMUX_LINES` | `tmux_read` 默认行数 | `100` |
| `PI_TMUX_TIMEOUT_SEC` | `tmux_wait` 默认超时 | `120` |

## Windows 便携版（原生后端）

`runTmux` win32 分支：无 tmux——bash -c + `--noprofile` 执行命令 + Node 管道写日志 + pidfile/taskkill 树杀。`tmux_run/read/status/wait/stop` 全可用；限制：bash -c 会话无 stdin 交互（`tmux_send` 仅 Ctrl-C/读取/停止），长驻命令需自写循环（如 `while true; do ...; sleep 5; done`）。扩展启动的 `-V` 探测已伪报版本通过。

## 环境缺失时的行为

tmux 未安装时，所有工具返回**清晰的可修复错误**（含各系统安装命令与排查指引），不会崩溃；模型可直接按指引安装后重试。参考 `~/.pi/docs/alacritty-tmux-setup.md`（WSL2/Alacritty 部署问题汇总）。

## 数据

- 日志：`~/.pi/logs/tmux/<会话>.log`（git 忽略）
- 注册表：`~/.pi/agent/.pi-tmux-registry.json`（记录本扩展创建的会话，用于退出清理）

## 开发

```bash
npm install
npx vitest run        # 纯函数 + 真实 tmux 生命周期集成测试
```

## 故障排查

**`access not allowed`**：所有 tmux 命令 stderr 报 `access not allowed` 但 exit 0、会话创建无效 → 陈旧 tmux 服务器导致（曾发现 2023 年启动的进程）。实证根因：proot 环境下 tmux server 被 kill -9 后 **socket 文件残留**（内核不清理），后续所有 tmux 命令报 access not allowed。修复：`kill -9 <tmux pid>` + `rm -rf /tmp/tmux-*` 后重试，无需重启机器。pi-wrapper.sh 已内置 ensure_tmux 自愈（每次 pi 启动检测 access not allowed 症状自动清理重建，pi 在 tmux 内时跳过防误杀）。
