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
| `tmux_run` | 在 detached tmux 会话执行命令，输出落盘日志 |
| `tmux_status` | 列出所有 tmux 会话（含用户会话），标注附加状态 |
| `tmux_read` | 读取会话最近输出（日志尾部 N 行，缺失回退 capture-pane） |
| `tmux_send` | 向会话发送文本/回车/Ctrl 组合键 |
| `tmux_stop` | 结束会话，可选删除日志 |
| `tmux_wait` | 等待会话结束 / 日志出现 pattern / 超时 |

## 用法示例

```bash
# 启动长任务（不阻塞对话）
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

## 配置

`~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）：

```json
{
  "pi-tmux": {
    "bin": "tmux",
    "prefix": "pi-",
    "log_dir": "~/.pi/logs/tmux",
    "default_lines": 100,
    "default_timeout_sec": 120
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_TMUX_BIN` | tmux 可执行文件路径 | `tmux` |
| `PI_TMUX_PREFIX` | 会话名前缀 | `pi-` |
| `PI_TMUX_LOG_DIR` | 日志目录 | `~/.pi/logs/tmux` |
| `PI_TMUX_LINES` | `tmux_read` 默认行数 | `100` |
| `PI_TMUX_TIMEOUT_SEC` | `tmux_wait` 默认超时 | `120` |

## 环境缺失时的行为

tmux 未安装时，所有工具返回**清晰的可修复错误**（含各系统安装命令与排查指引），不会崩溃；模型可直接按指引安装后重试。参考 `~/.pi/alacritty-tmux-setup.md`（WSL2/Alacritty 部署问题汇总）。

## 数据

- 日志：`~/.pi/logs/tmux/<会话>.log`（git 忽略）
- 注册表：`~/.pi/agent/.pi-tmux-registry.json`（记录本扩展创建的会话，用于退出清理）

## 开发

```bash
npm install
npx vitest run        # 纯函数 + 真实 tmux 生命周期集成测试
```
