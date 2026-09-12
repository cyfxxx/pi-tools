# pi-tmux — tmux 集成扩展

> tmux 集成扩展：让 Pi 的 LLM 智能使用 tmux 管理持久后台任务。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 后台任务、长任务、交互程序 |
| 相关文档 | [alacritty-tmux-setup.md](../../../../docs/operations/alacritty-tmux-setup.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、会话管理](#六会话管理)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 内建 `bash` 工具是**非交互管道**（无 TTY、带 timeout/abort）——长任务（dev server、watch、build）、交互程序、TUI 程序要么输出被截断要么会话中断。

### 1.2 设计理念

- **持久 TTY 会话**：`tmux new-session -d` 创建 detached 会话，不依赖当前终端存活
- **输出落盘**：`pipe-pane -o` 把 pane 输出持续写入日志，读取走日志尾部，稳定不丢历史
- **交互**：`send-keys` 注入文本 / Ctrl 组合键（如中断运行中的任务）
- **等待语义**：`wait` 轮询直到会话退出 / 日志出现关键字
- **生命周期**：会话统一 `pi-` 前缀；pi 退出时自动清理本扩展创建的会话

---

## 二、架构

### 2.1 系统架构图

```
用户请求 → tmux_run → 创建 detached tmux 会话
    ↓
命令执行 → 输出写入日志文件
    ↓
tmux_read → 读取日志尾部
    ↓
tmux_wait → 等待会话结束/pattern 出现
    ↓
会话结束 → 自动唤醒主会话
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 工具层 | `tools.ts` | 注册 tmux_run/read/send/wait/stop/status 工具 |
| 核心层 | `core.ts` | tmux 命令执行、日志管理 |
| 配置层 | `config.ts` | 配置加载、环境变量解析 |
| 监控层 | `watcher.ts` | 会话完成监控、自动唤醒 |
| 注册表 | `.pi-tmux-registry.json` | 记录本扩展创建的会话 |

---

## 三、功能

### 3.1 工具清单

| 工具 | 功能 |
|------|------|
| `tmux_run` | 在 detached tmux 会话执行命令，输出落盘日志；`notify`（布尔，默认 true）任务结束自动触发新回合汇报 |
| `tmux_status` | 列出所有 tmux 会话（含用户会话），标注附加状态 |
| `tmux_read` | 读取会话最近输出（日志尾部 N 行，缺失回退 capture-pane） |
| `tmux_send` | 向会话发送文本/回车/Ctrl 组合键 |
| `tmux_stop` | 结束会话，可选删除日志 |
| `tmux_wait` | 等待会话结束 / 日志出现 pattern / 超时 |

### 3.2 完成自动唤醒

`tmux_run` 启动会话后轮询 `tmux has-session`（5s），会话消失即视为完成，经 `pi.sendMessage({customType:'pi-tmux-notify'},{triggerTurn:true})` 注入通知并触发新回合——后台任务结束后主会话自动被唤醒查看结果并收尾，无需用户发消息。

**会话结束语义**：
- 命令自然结束（成功或失败）时 shell 退出、会话结束——唤醒依赖此判定
- 退出码 130（SIGINT 中断，如 `tmux_send ctrl_key="c"`）保留 shell，维持"中断后继续交互"的用法
- 长驻命令（dev server/watch）永不执行到退出语句，会话持续保留

### 3.3 防积压机制

1. **同批合并**：完成事件先入 pending 队列，`MERGE_WINDOW_MS`（5s = 轮询间隔）固定窗口从首个完成起算，窗口内到期的会话合成一条汇总通知
2. **消费标记**：`tmux_read` 成功读取后 `watcher.ack(name)`，该会话完成时不再通知（已人工查看过）
3. **主动停止丢弃**：`tmux_stop` 的 `stop()` 丢弃该会话 pending 条目，防轮询竞态触发空通知

---

## 四、配置项

### 4.1 配置文件

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

### 4.2 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_TMUX_BIN` | tmux 可执行文件路径 | `tmux` |
| `PI_TMUX_PREFIX` | 会话名前缀 | `pi-` |
| `PI_TMUX_LOG_DIR` | 日志目录 | `~/.pi/logs/tmux` |
| `PI_TMUX_LINES` | `tmux_read` 默认行数 | `100` |
| `PI_TMUX_TIMEOUT_SEC` | `tmux_wait` 默认超时 | `120` |

---

## 五、使用方法

### 5.1 基本用法

```bash
# 启动长任务（不阻塞对话）；任务结束自动触发新回合汇报
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

### 5.2 查看会话状态

```bash
# 列出所有会话
tmux_status()

# 查看特定会话日志
tmux_read(name="build", lines=100)
```

### 5.3 等待任务完成

```bash
# 等待会话结束
tmux_wait(name="build", timeout=300)

# 等待日志出现关键字
tmux_wait(name="build", pattern="Compiled successfully", timeout=300)
```

---

## 六、会话管理

### 6.1 会话名约束

- 会话名仅允许字母/数字/`_`/`-`（≤40 字符）
- 非法名（含路径分隔符如 `../`）一律拒绝返回错误——防会话名路径穿越

### 6.2 会话生命周期

- 会话统一 `pi-` 前缀
- pi 退出时自动清理本扩展创建的会话（绝不触碰用户会话 main/work 等）
- 注册表：`~/.pi/agent/extensions/pi-tmux/.pi-tmux-registry.json`

### 6.3 日志管理

- 日志目录：`~/.pi/logs/tmux/<会话>.log`（git 忽略）
- 日志格式：纯文本，按时间追加
- 日志清理：`tmux_stop` 时可选删除日志

### 6.4 Windows 便携版

`runTmux` win32 分支：无 tmux——bash -c + `--noprofile` 执行命令 + Node 管道写日志 + pidfile/taskkill 树杀。`tmux_run/read/status/wait/stop` 全可用；限制：bash -c 会话无 stdin 交互（`tmux_send` 仅 Ctrl-C/读取/停止），长驻命令需自写循环（如 `while true; do ...; sleep 5; done`）。

---

## 七、已知问题

### 7.1 `access not allowed` 错误

**症状**：所有 tmux 命令 stderr 报 `access not allowed` 但 exit 0、会话创建无效

**原因**：陈旧 tmux 服务器导致（曾发现 2023 年启动的进程）。实证根因：proot 环境下 tmux server 被 kill -9 后 **socket 文件残留**（内核不清理），后续所有 tmux 命令报 access not allowed。

**修复**：
```bash
kill -9 <tmux pid>
rm -rf /tmp/tmux-*
```

pi-wrapper.sh 已内置 ensure_tmux 自愈（每次 pi 启动检测 access not allowed 症状自动清理重建，pi 在 tmux 内时跳过防误杀）。

### 7.2 环境缺失时的行为

tmux 未安装时，所有工具返回**清晰的可修复错误**（含各系统安装命令与排查指引），不会崩溃；模型可直接按指引安装后重试。

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-tmux
npm install
npx vitest run
```

### 8.2 测试覆盖

- 纯函数测试
- 真实 tmux 生命周期集成测试
- 竞态测试
- owner 关闭测试
- Windows 兼容测试

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-19 | v1.0 | 防积压机制、完成自动唤醒、会话名约束 |
| 2026-08-XX | v1.0 | 初始版本，实现 tmux 集成 |