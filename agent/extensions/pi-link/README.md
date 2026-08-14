# pi-link 扩展 — 多设备 pi 互联

让一台设备上的 pi **直接与其他设备（局域网 / Tailscale 组网）上运行的 pi 通信**：
发消息、远程处理、取回最终回复——pi agent 之间互相调派，无需人工中转。

## 原理

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

- **零新增服务**：SSH 即通道，目标设备无需跑任何守护进程（只需 sshd + pi）
- **结构化**：官方 RPC 事件流，`agent_settled` 判定完成，非文本解析
- **多轮会话**：`--session-dir` 持久化，目标设备可用 `pi -c`/`/resume` 查看历史；同一设备多次调用默认复用上次会话（switch_session，见 T1 会话连续性），上下文连续

## 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `link_send` | `device`, `message`, `timeoutSec?` | 向目标设备 pi 发消息，等待完成，返回最终回复（含流式进度回传） |
| `link_status` | — | 设备清单 + 连通性探测（● 可达 / ○ 不可达） |

## 斜杠命令

`/link send <设备> <消息>` — 发送消息并等待回复（无人值守拒绝）
`/link watch <设备> [--lines N]` — 观察远程 pi 会话尾部（模型间沟通可见）
`/link attach <设备> [--force] <文本>` — 介入：向远程 pi 输入框发送文本（等价在远程终端打字；远程 busy 时拒绝，--force 强制）
`/link inbox <设备>` — 读取远程信箱（远程 agent 自主完成的回复记录，环形 10 条）
`/link export-card` / `/link import-card <JSON>` — 设备卡片交换（含 IP/用户，import 后直接可用）
`/link status` — 设备清单与连通性
`/link help` — 用法与配置说明

## 活跃设备/身份机制（T2-1）

防止"我不在控制的设备乱指挥"：

- 本机 pi-link 监听用户输入（input 事件）刷新活跃时间戳（`~/.pi/pi-link-active.json`）
- `link_send` 发送前校验：**无人值守环境**（pi-cron 定时任务设 `PI_UNATTENDED=1`）或**本机 15 分钟无用户交互**时默认拒绝，报错提示
- `~/.pi/pi-link.json` 设 `"allowUnattended": true` 可放开（指令头仍标注无人值守）
- 设备身份：`selfName`（默认 hostname）

## 信箱（T2-3）

每台设备 pi-link 在 agent 一轮结束（agent_end）时，把最终回复写入本机信箱
`~/.pi/pi-link-outbox.json`（环形缓冲 10 条）。其他设备 `/link inbox <设备>`
可随时查看该设备自主完成的任务结果——B→A 方向的结果留存（无需在线同步等待）。

## 并发保护与去重（T2-4）

- 同设备并发：进程内锁，已有进行中的调用时拒绝新调用（提示等完成）
- 同设备同消息：5 分钟内相同消息自动去重（防模型重复调用），确需重发请改动内容或稍等

## 设备卡片交换（T2-5）

- `/link export-card`：生成本机卡片（自动探测 Tailscale IP / 内网 IP）
- 把卡片 JSON 发给其他设备 → `/link import-card <JSON>`：校验并写入 pi-link.json
- 卡片为 A2A Agent Card 简版（name/skills/host/user/port/pi）——交换式发现，
  不引入 mDNS/HTTP daemon（ssh 通道零守护是 pi-link 架构优势）

## 远程状态与冲突防护（T2-2）

- 每台设备 pi-link 维护 `~/.pi/pi-link-state.json`（status idle/busy + currentTask + tmuxSession + currentSessionFile）
- `/link watch` 读远程状态定位当前会话文件，tail 压缩显示（只读）
- `/link attach` 先读远程状态：**busy 时拒绝介入**（提示当前任务），`--force` 强制打断；发送走 ssh + 远程 tmux load-buffer/paste-buffer（等价粘贴进输入框）
- 注意：远程状态文件由远程设备的 pi-link 扩展维护（需远程同步代码后重启 pi）

## 配置 `~/.pi/pi-link.json`（gitignored，每设备独立）

```json
{
  "devices": {
    "phone":  { "host": "100.101.102.103", "user": "u0_a123", "port": 8022, "timeoutSec": 600 },
    "laptop": { "host": "100.200.300.400", "user": "myuser", "cwd": "~/work" }
  },
  "defaultTimeoutSec": 600
}
```

| 字段 | 说明 |
|------|------|
| `host` | Tailscale IP 或局域网 IP |
| `user` | SSH 用户名（Termux 通常 `u0_a123` 等） |
| `port` | SSH 端口，默认 22（Termux sshd 常为 8022） |
| `cwd` | 远程 RPC 工作目录（可选，默认远程用户 home） |
| `timeoutSec` | 单次调用超时（默认 `defaultTimeoutSec`=600） |
| `sessionDir` | 远程会话存储目录（默认 `~/.pi/agent/sessions/pi-link`） |
| `extensions` | true 时远程加载扩展（默认 false，见安全） |
| `sshArgs` | 附加 ssh 参数（如 `["-i", "~/.ssh/id_ed25519"]`） |

`PI_LINK_CONFIG` 环境变量可覆盖配置文件路径。

## 目标设备准备（一次性）

1. 安装并启动 sshd（Termux: `pkg install openssh` + `sshd`；其他系统自备）
2. **公钥授权（推荐：仓库合集）**：所有设备公钥集中存放在仓库 `deploy/keys/authorized_keys`（git 同步），每台设备跑一次 `bash scripts/pi-link-keys.sh install` 即获得全部设备授权（幂等；Termux 自动写 proot 与 Termux 双位置）；新设备加入 = 把其公钥追加进合集（`pi-link-keys.sh add <公钥>`）→ 提交推送 → 其他设备 pull + install。rebuild.sh Phase 2-F3 已自动集成
3. 确认 `pi` 命令在 ssh 非交互 shell 的 PATH 中（Termux 建议在 `~/.bashrc`/`~/.profile` 导出，或用绝对路径）

### 加固（可选，推荐）

目标设备 `authorized_keys` 该条目加 forced command，将 A 的 ssh 通道限制为只能启动 pi RPC：

```
command="~/.pi/scripts/pi-link-entry.sh",restrict ssh-ed25519 AAAA...
```

（入口脚本校验后以固定参数 exec `pi --mode rpc --no-extensions --session-dir ~/.pi/agent/sessions/pi-link`，A 无法执行其他命令）

## 设备接入 / 升级流程

### 新设备接入（双向）

1. **安装公钥合集**（仓库已入库所有设备公钥）：
   ```bash
   bash ~/.pi/scripts/pi-link-keys.sh install   # 把 deploy/keys/authorized_keys 合并进本机 ~/.ssh/authorized_keys
   ```
2. **注册本机公钥**（供其他设备免密连入）：`bash ~/.pi/scripts/pi-link-keys.sh export` 输出本机公钥 → 在其设备 `add` 后 push，其他设备 pull + install
3. **交换设备卡片**：本机 `/link export-card` 生成卡片 → 对方设备 `/link import-card <JSON>` 写入 pi-link.json（或直接手动编辑 `~/.pi/pi-link.json`，格式见 config.ts）
4. **验证**：`/link status` 应显示对方可达；`/link send <设备> 测试` 往返一次

> pi-link.json（设备清单）、pi-link-active.json/state.json/outbox.json（运行时状态）均 **gitignored、每环境独立**——多设备 git 同步不会互相覆盖；换机/重装后设备清单需重新配置（或用 `pi-backup create` 归档带走）。

### 升级已部署设备

1. 本机：`git push`（或远程自己 pull）
2. 远程：`cd ~/.pi && git pull --rebase origin master`（entries.json 冲突时 `git checkout --theirs memory/entries.json` 保留远程）
3. 远程重启 pi（退出重进或 `/admin:restart`）——扩展代码在启动时加载，**不重启不生效**（状态文件/信箱/watch/attach 均依赖新版扩展）
4. 验证：远程 `~/.pi/pi-link-state.json` 出现且含 `tmuxSession` 字段即加载成功

### Termux 设备特别说明

- 远程命令链依赖 **unset LD_PRELOAD**（libtermux-exec 破坏 node）——buildRemoteCommand 已处理，无需手动干预
- Termux sshd 读取的是 Termux home 的 `~/.ssh`（非 proot `/root/.ssh`）——公钥安装路径在 Termux 环境自动双写（见 pi-link-keys.sh）
- **双 home 分裂**：pi 扩展（proot 内）homedir()=/root（状态/信箱写 `/root/.pi/`），但 sshd 会话 `~`=Termux home（`/data/data/.../home/`）——远程读取必须双路径回退（`$HOME` 优先，`/root` 兜底），link.ts 已内置（readRemoteState/readRemoteOutbox/watchRemote）
- Windows 设备：OpenSSH 默认登录 shell 是 cmd，远程 bash 命令会失败——需将登录 shell 配为 git-bash/WSL 后再接入

## 安全边界

- **传输**：SSH 密钥认证；建议仅在 Tailscale 私有网络（或受信局域网）内使用，勿暴露公网
- **远程能力**：A 可驱动 B 的 pi 执行 B 用户权限内的任何命令——默认 `--no-extensions`（不加载 B 的扩展：不暴露 B 的记忆库、不触发 plan-mode 三选一/autopilot 调度/voice 等）；需要远程扩展能力时显式 `"extensions": true`
- **交互请求**：远程 agent 若调用 ask_user/UI 交互（`extension_ui_request` 事件），调用立即失败返回错误（避免挂起），由 B 侧用户手动处理该会话
- **上下文**：默认独立会话，A 无法读取 B 的其他会话内容（会话文件在 B 侧本地）

## 测试

```bash
cd agent/extensions/pi-link && ./node_modules/.bin/vitest run
```

用例：extractReply 文本提取（排除 thinking/toolCall）、buildRemoteCommand 参数组装（--no-extensions/cwd/sessionDir）、sendToDevice 全流程（mock ssh 子进程：完成判定/交互请求错误/无回复错误）、index 注册面（工具 + /link 命令整合 + 参数错误）。

## 演进方向（分档，待需求出现再评估）

### T2 已全部实现（活跃/身份、watch/attach、信箱、并发去重、设备卡片）

剩余未做项：
- **B→A 主动推送**：远程完成后主动通知本机（当前为信箱+watch 手动拉取；需 ssh 反向隧道或常驻连接）
- **任务队列**：多任务排队（当前为并发拒绝 + 5 分钟去重）
- **设备自动发现**：mDNS/DNS-SD 广播（当前为卡片交换式）

### T3（架构演进，暂缓）

- **A2A 协议落地**：JSON-RPC over HTTP + Agent Card 发现 + task 生命周期，与外部 agent 生态互通（当前全是 pi，无互通需求；若出现非 pi 设备再评估）
- **受限模式**：远程白名单工具集（当前远程是全能力 RPC）
- **relay 中心**：跨网（非 Tailscale）场景 + 手机移动端接入（remote_pi 模式）

### 已实现（T1）

- **会话连续性**：switch_session 复用上次会话（同一设备多次调用上下文连续；>1MB 自动开新会话；`sessionPolicy: fresh` 可关闭）
- **流式回传**：远程工具执行进度实时转发（onUpdate）
- **指令模板**：消息自动加远程执行指令前缀，消除措辞歧义
