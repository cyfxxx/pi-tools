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
