# pi-webui 扩展 — WebUI 聊天界面

替代 ntfy-relay，提供基于浏览器的实时聊天界面，支持群聊和私聊，适配桌面端和移动端。

## 功能

- **群聊**：所有设备的 pi agent + 用户一起聊天，每个 agent 根据消息内容选择是否回复
- **私聊**：用户与单个设备的 pi agent 单独通信
- **实时通信**：WebSocket 替代 ntfy 的 5s 轮询
- **响应式设计**：适配桌面端和移动端浏览器
- **暗色/亮色主题**：跟随系统设置
- **设备间通信**：复用 pi-link SSH 隧道，零新增守护进程
- **消息持久化**：JSON 文件存储，支持历史消息加载

## 快速开始

```bash
# 在 pi 中执行
/webui start
```

浏览器打开输出的地址（格式：`http://<IP>:3100?token=<token>`）

## 命令

| 命令 | 说明 |
|------|------|
| `/webui` | 显示状态和访问地址 |
| `/webui start` | 启动服务 |
| `/webui stop` | 停止服务 |
| `/webui status` | 显示设备在线状态 |

## 架构

```
用户浏览器 ←WebSocket→ 本机 pi-webui server ←SSH→ 其他设备 pi-webui server
                            ↕
                        本机 pi agent
```

- 每台设备独立运行 HTTP + WebSocket 服务
- 设备间通过 pi-link SSH 隧道转发消息
- pi agent 通过 `agent_end` 事件钩子参与聊天

## 配置

配置文件：`~/.pi/webui/config.json`

```json
{
  "port": 3100,
  "host": "0.0.0.0",
  "authToken": "自动生成的 token",
  "maxMessageHistory": 1000,
  "enableFileUpload": false
}
```

首次启动自动生成 authToken，后续启动复用。

## 消息流程

### 群聊

```
用户输入 → WebUI server → 广播给所有设备 + 本机 pi agent
                        → 其他设备 pi-webui server → 该设备 pi agent (选择性回复)
```

### 私聊

```
用户输入 → WebUI server → 定向发送到目标设备 → 该设备 pi agent 处理并回复
```

## 文件结构

```
pi-webui/
├── index.ts              # 扩展入口
├── types.ts              # 消息协议类型
├── server.ts             # HTTP 服务器
├── ws-hub.ts             # WebSocket 连接管理
├── message-store.ts      # 消息持久化
├── device-bridge.ts      # 设备间 SSH 桥接
├── pi-agent-hook.ts      # agent 事件钩子
├── static/               # 前端构建产物
└── ui/                   # 前端源码 (React/Vite)
```

## 设备在线状态

`server.ts` 的 `mergeDeviceStatuses()` 是**唯一**设备状态来源，`/api/devices` 与 WebSocket 初始 `device_list` 共用，与 `/webui status` 保持一致。合并规则：

| 来源 | 覆盖设备 | 在线含义 |
|------|----------|----------|
| 本机 self | `selfDevice` | 恒在线（服务提供方） |
| SSH 桥接 | pi-link 清单除 self | 目标设备 `pi --mode rpc` 子进程存活 |
| WebSocket | 任意设备名 | 该设备以设备身份连上 `/ws` |

实现约束（改动时勿回退）：

- **以设备集合为遍历基准**：先 self，再 bridge 设备，最后补 hub 独有设备。不可只遍历 hub 状态，否则仅有 SSH 的远程设备与本机都会从列表消失
- **浏览器占位身份 `device=user&user=1` 不是设备**：不计入 `deviceOnline`、不广播 `presence`，否则侧边栏多出 `user` 会话
- **认证覆盖面**：仅 `/api/*` 需鉴权（`Authorization: Bearer <token>` 或 `?token=`），静态资源与首页放行；`/ws` 握手在 `wss.on('connection')` 内单独校 `?token=`，不匹配则 `close(4001)`。首次启动自动生成 token 写入 `config.json`
- **`device_list` 需随状态变化推送**：bridge 的 `onStatusChange`（SSH 连上/断开）触发 `hub.broadcastDeviceList()`。仅在 WS 建连时发一次会停留在旧状态——bridge 延迟 3s 才标记在线，列表会一直显示离线

## 开发

```bash
cd ui/
npm install
npm run dev    # 开发服务器 (热重载)
npm run build  # 构建到 static/
```

## 依赖

- Node.js 20+
- pi-link 配置 (`~/.pi/pi-link.json`) 用于设备间通信
- `ws` 包（WebSocket）

## 替代 ntfy-relay

| 特性 | ntfy-relay | pi-webui |
|------|-----------|----------|
| 延迟 | 5s 轮询 | 实时 |
| 群聊 | ❌ | ✅ |
| 双向 | ❌ | ✅ |
| 自托管 | 依赖 ntfy.sh | 零外部依赖 |
| 文件传输 | ❌ | v2 计划中 |
