# pi-link — 多设备 pi 互联

> 让一台设备上的 pi **直接与其他设备（局域网 / Tailscale 组网）上运行的 pi 通信**：发消息、远程处理、取回最终回复——pi agent 之间互相调派，无需人工中转。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 多设备互联、远程调用 |
| 相关文档 | [pi-link.json](../../../pi-link.json), [pi-link-keys.sh](./scripts/pi-link-keys.sh) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、安装与配置](#六安装与配置)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

多设备环境下需要：
- 设备间互相调派任务
- 远程执行复杂操作
- 结果回传和同步

### 1.2 设计理念

- **零新增服务**：SSH 即通道，目标设备无需跑任何守护进程（只需 sshd + pi）
- **结构化**：官方 RPC 事件流，`agent_settled` 判定完成，非文本解析
- **多轮会话**：`--session-dir` 持久化，目标设备可用 `pi -c`/`/resume` 查看历史
- **安全边界**：默认 `--no-extensions`，不加载远程扩展，防止意外操作

---

## 二、架构

### 2.1 系统架构图

```
设备 A（本机, pi TUI/会话）
  │  link_send(device, message)      ← 扩展工具
  ▼
ssh 通道（密钥认证，Tailscale/局域网）
  ▼
设备 B: pi --mode rpc --no-extensions --session-dir ~/.pi/agent/sessions/pi-link
  │  JSONL 协议（pi 官方 RPC 模式）
  ▼
B 的 pi 收到 prompt → 使用 B 的工具执行（bash/read/…）→ 完成后事件流回传
  ▼
设备 A 的 pi 获得最终回复 + 统计（轮次/工具调用/模型/耗时）
```

### 2.2 核心组件

| 组件 | 功能 |
|------|------|
| 工具层 | `link_send`、`link_status` 工具 |
| 命令层 | `/link send\|watch\|attach\|inbox\|export-card\|import-card\|status\|help` 命令 |
| 通信层 | SSH 通道、JSONL 协议 |
| 状态层 | 设备状态、活跃检测、信箱管理 |
| 安全层 | 并发保护、去重、注入防护 |

---

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `link_send` | `device`, `message`, `timeoutSec?` | 向目标设备 pi 发消息，等待完成，返回最终回复（含流式进度回传） |
| `link_status` | — | 设备清单 + 连通性探测（● 可达 / ○ 不可达） |

### 3.2 命令清单

| 命令 | 说明 |
|------|------|
| `/link send <设备> <消息>` | 发送消息并等待回复（无人值守拒绝） |
| `/link watch <设备> [--lines N]` | 观察远程 pi 会话尾部（模型间沟通可见） |
| `/link attach <设备> [--force] <文本>` | 介入：向远程 pi 输入框发送文本 |
| `/link inbox <设备>` | 读取远程信箱（远程 agent 自主完成的回复记录） |
| `/link export-card` | 生成本机设备卡片 |
| `/link import-card <JSON>` | 导入设备卡片 |
| `/link status` | 设备清单与连通性 |
| `/link help` | 用法与配置说明 |

### 3.3 与直接 ssh 的边界

`link_send` 的价值是"远程 agent 自主处理"，不是"远程执行命令"。判断准则：

- **单条确定性命令**（更新包、查状态、跑脚本）→ 本机直接用 `bash` 执行 `ssh host "cmd"`，更快、无双重 LLM 开销
- **需要远程 pi 自主多步处理**（拆解任务、判断纠错、输出报告）→ `link_send`
- 远程设备未安装 pi 时本扩展不可用（只有 ssh 通道）

### 3.4 活跃设备/身份机制

防止"我不在控制的设备乱指挥"：

- 本机 pi-link 监听用户输入（input 事件）刷新活跃时间戳（`~/.pi/pi-link-active.json`）
- `link_send` 发送前校验：**无人值守环境**（pi-cron 定时任务设 `PI_UNATTENDED=1`）或**本机 15 分钟无用户交互**时默认拒绝，报错提示
- `~/.pi/pi-link.json` 设 `"allowUnattended": true` 可放开（指令头仍标注无人值守）
- 设备身份：`selfName`（默认 hostname）

### 3.5 信箱

每台设备 pi-link 在 agent 一轮结束（agent_end）时，把最终回复写入本机信箱 `~/.pi/pi-link-outbox.json`（环形缓冲 10 条）。其他设备 `/link inbox <设备>` 可随时查看该设备自主完成的任务结果——B→A 方向的结果留存（无需在线同步等待）。

### 3.6 并发保护与去重

- 同设备并发：进程内锁（inflight），已有进行中的调用时拒绝新调用（提示等完成）
- 宿主取消信号（AbortSignal）：工具中止时 SIGKILL ssh 子进程，返回"调用已被取消"，并释放 inflight 锁
- 同设备同消息：5 分钟窗口去重，指纹**仅发送成功后写入**——失败/超时不占窗口，同消息可直接重发

### 3.7 设备卡片交换

- `/link export-card`：生成本机卡片（自动探测 Tailscale IP / 内网 IP）
- 把卡片 JSON 发给其他设备 → `/link import-card <JSON>`：校验并写入 pi-link.json
- 卡片为 A2A Agent Card 简版（name/skills/host/user/port/pi）——交换式发现，不引入 mDNS/HTTP daemon

### 3.8 远程状态与冲突防护

- 每台设备 pi-link 维护 `~/.pi/pi-link-state.json`（status idle/busy + currentTask + tmuxSession + currentSessionFile）
- `/link watch` 读远程状态定位当前会话文件，tail 压缩显示（只读）
- `/link attach` 先读远程状态：**busy 时拒绝介入**（提示当前任务），`--force` 强制打断

---

## 四、配置项

### 4.1 配置文件

`~/.pi/pi-link.json`（gitignored，每设备独立）：

```json
{
  "devices": {
    "phone":  { "host": "100.101.102.103", "user": "u0_a123", "port": 8022, "timeoutSec": 600 },
    "laptop": { "host": "100.200.300.400", "user": "myuser", "cwd": "~/work" }
  },
  "defaultTimeoutSec": 600
}
```

### 4.2 字段说明

| 字段 | 说明 |
|------|------|
| `host` | Tailscale IP 或局域网 IP；可配 `altHosts`（备用地址列表，主地址连不上时依次 failover） |
| `user` | SSH 用户名（Termux 通常 `u0_a123` 等） |
| `port` | SSH 端口，默认 22（Termux sshd 常为 8022） |
| `cwd` | 远程 RPC 工作目录（可选，默认远程用户 home） |
| `timeoutSec` | 单次调用超时（默认 `defaultTimeoutSec`=600） |
| `sessionDir` | 远程会话存储目录（默认 `~/.pi/agent/sessions/pi-link`） |
| `extensions` | true 时远程加载扩展（默认 false，见安全） |
| `sshArgs` | 附加 ssh 参数（如 `["-i", "~/.ssh/id_ed25519"]`） |

### 4.3 环境变量

| 变量 | 说明 |
|------|------|
| `PI_LINK_CONFIG` | 覆盖配置文件路径 |
| `PI_UNATTENDED` | 标记无人值守环境 |

---

## 五、使用方法

### 5.1 基本用法

```bash
# 发送消息并等待回复
/link send phone "查看手机存储空间"

# 观察远程会话
/link watch phone --lines 50

# 读取远程信箱
/link inbox phone

# 查看设备状态
/link status
```

### 5.2 设备卡片交换

```bash
# 生成本机卡片
/link export-card

# 导入对方卡片
/link import-card <JSON>
```

### 5.3 远程介入

```bash
# 向远程 pi 输入框发送文本
/link attach phone "停止当前任务"

# 强制介入
/link attach phone --force "停止当前任务"
```

---

## 六、安装与配置

### 6.1 目标设备准备（一次性）

1. 安装并启动 sshd（Termux: `pkg install openssh` + `sshd`；其他系统自备）
2. **公钥授权（推荐：仓库合集）**：所有设备公钥集中存放在仓库 `extensions/pi-link/keys/authorized_keys`（git 同步），每台设备跑一次 `bash scripts/pi-link-keys.sh install` 即获得全部设备授权
3. 确认 `pi` 命令在 ssh 非交互 shell 的 PATH 中

### 6.2 加固（可选，推荐）

目标设备 `authorized_keys` 该条目加 forced command，将 A 的 ssh 通道限制为只能启动 pi RPC：

```
command="~/.pi/scripts/pi-link-entry.sh",restrict ssh-ed25519 AAAA...
```

> **与状态探测的互斥**：加固模式下 forced command 忽略一切远程命令，`/link status` 的可达探测与 watch/inbox 等远程查询将全部失败、误报离线；`link_send` 因入口参数兼容仍可用。需要完整状态面则不要对该公钥启用 forced command。

### 6.3 新设备接入（双向）

1. **安装公钥合集**：
   ```bash
   bash ~/.pi/scripts/pi-link-keys.sh install
   ```
2. **注册本机公钥**：`bash ~/.pi/scripts/pi-link-keys.sh export` 输出本机公钥 → 在其设备 `add` 后 push，其他设备 pull + install
3. **交换设备卡片**：本机 `/link export-card` 生成卡片 → 对方设备 `/link import-card <JSON>` 写入 pi-link.json
4. **验证**：`/link status` 应显示对方可达；`/link send <设备> 测试` 往返一次

### 6.4 升级已部署设备

1. 本机：`git push`（或远程自己 pull）
2. 远程：`cd ~/.pi && git pull --rebase origin master`
3. 远程重启 pi（`admin_restart` 工具或退出重进均可）
4. 验证：远程 `~/.pi/pi-link-state.json` 出现且含 `tmuxSession` 字段即加载成功

### 6.5 Termux 设备特别说明

- 远程命令链依赖 **unset LD_PRELOAD**（libtermux-exec 破坏 node）——buildRemoteCommand 已处理，无需手动干预
- Termux sshd 读取的是 Termux home 的 `~/.ssh`（非 proot `/root/.ssh`）——公钥安装路径在 Termux 环境自动双写
- **双 home 分裂**：pi 扩展（proot 内）homedir()=/root，但 sshd 会话 `~`=Termux home——远程读取必须双路径回退
- Windows 设备：OpenSSH 默认登录 shell 是 cmd，远程 bash 命令会失败——需将登录 shell 配为 git-bash/WSL 后再接入

---

## 七、已知问题

- **加固模式下状态探测失败**：forced command 忽略远程命令，`/link status` 等查询将误报离线
- **双 home 分裂**：Termux 环境下远程读取必须双路径回退
- **Windows 设备**：需将登录 shell 配为 git-bash/WSL 后再接入
- **远程扩展默认关闭**：默认 `--no-extensions`，不加载远程扩展，需显式 `"extensions": true`

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-link
./node_modules/.bin/vitest run
```

### 8.2 测试覆盖

- extractReply 文本提取（排除 thinking/toolCall）
- buildRemoteCommand 参数组装（--no-extensions/cwd/sessionDir）
- sendToDevice 全流程（mock ssh 子进程：完成判定/交互请求错误/无回复错误）
- index 注册面（工具 + /link 命令整合 + 参数错误）

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现多设备互联功能 |

---

## 十、演进方向

### T2 已全部实现

- 活跃/身份、watch/attach、信箱、并发去重、设备卡片

### 剩余未做项

- **B→A 主动推送**：远程完成后主动通知本机（当前为信箱+watch 手动拉取）
- **任务队列**：多任务排队（当前为并发拒绝 + 5 分钟去重）
- **设备自动发现**：mDNS/DNS-SD 广播（当前为卡片交换式）

### T3（架构演进，暂缓）

- **A2A 协议落地**：JSON-RPC over HTTP + Agent Card 发现 + task 生命周期
- **受限模式**：远程白名单工具集
- **relay 中心**：跨网（非 Tailscale）场景 + 手机移动端接入