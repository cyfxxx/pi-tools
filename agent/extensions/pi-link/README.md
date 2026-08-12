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
- **多轮会话**：`--session-dir` 持久化，目标设备可用 `pi -c`/`/resume` 查看历史（A 的每次调用是独立会话，上下文不跨调用延续——需要连续对话请在 message 中附上下文或后续版本支持 load_session）

## 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `link_send` | `device`, `message`, `timeoutSec?` | 向目标设备 pi 发消息，等待完成，返回最终回复 |
| `link_status` | — | 设备清单 + 连通性探测（● 可达 / ○ 不可达） |

## 斜杠命令

`/link send <设备> <消息>` — 发送消息并等待回复
`/link status` — 设备清单与连通性
`/link help` — 用法与配置说明

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
2. **公钥授权（推荐：仓库合集）**：所有设备公钥集中存放在仓库 `keys/authorized_keys`（git 同步），每台设备跑一次 `bash scripts/pi-link-keys.sh install` 即获得全部设备授权（幂等；Termux 自动写 proot 与 Termux 双位置）；新设备加入 = 把其公钥追加进合集（`pi-link-keys.sh add <公钥>`）→ 提交推送 → 其他设备 pull + install。rebuild.sh Phase 2-F3 已自动集成
3. 确认 `pi` 命令在 ssh 非交互 shell 的 PATH 中（Termux 建议在 `~/.bashrc`/`~/.profile` 导出，或用绝对路径）

### 加固（可选，推荐）

目标设备 `authorized_keys` 该条目加 forced command，将 A 的 ssh 通道限制为只能启动 pi RPC：

```
command="~/.pi/scripts/pi-link-entry.sh",restrict ssh-ed25519 AAAA...
```

（入口脚本校验后以固定参数 exec `pi --mode rpc --no-extensions --session-dir ~/.pi/agent/sessions/pi-link`，A 无法执行其他命令）

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

## 演进方向（未实现）

- **常驻会话**：daemon 化（每设备 linkd），HTTP/WS 接口 + A2A Agent Card 发现（`/.well-known/agent-card.json`）、mDNS 局域网发现、双向推送（B 主动发消息给 A）
- **会话连续性**：`load_session` 复用上次会话（已验证协议可用，需要"设备→会话文件"映射管理）
- **流式回传**：工具调用过程实时可见
