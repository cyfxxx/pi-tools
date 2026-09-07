---
name: pi-webui-debug-fix
description: 诊断并修复 pi-webui 扩展前端白屏问题，包括构建产物缺失、静态资源路由错误、WebSocket 认证失败等典型故障
---

## 触发条件
用户报告 webui 页面空白、无法显示聊天界面、访问地址后无任何内容。

## 诊断步骤

### 1. 确认症状
- 询问用户完整访问地址（格式：`http://<IP>:3100?token=<token>`）
- 让用户截图或描述空白页面的状态
- 多次确认排除网络延迟导致

### 2. 检查静态资源
```bash
ls -la ~/.pi/agent/extensions/pi-webui/static/
```
- 预期：包含 `index.html` 和 `assets/` 目录
- 若为空：需重新构建前端

### 3. 检查服务进程
```bash
netstat -tlnp 2>/dev/null | grep 3100 || ss -tlnp | grep 3100
pgrep -f "pi-webui\|webui"
```

### 4. 查看日志
```bash
# pi 会话日志中搜索 webui 相关输出
# 或在终端直接运行 webui 观察报错
```

## 修复方案

### 场景A：静态资源未构建
```bash
cd ~/.pi/agent/extensions/pi-webui/ui
npm install
npm run build
# 验证
ls -la ../static/
```

### 场景B：静态资源路径错误
编辑 `server.ts`，确认：
```typescript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
// 静态资源路径
app.use(express.static(join(__dirname, 'static')));
```

### 场景C：WebSocket 认证失败
检查 `ws-hub.ts` 握手逻辑：
```typescript
ws.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (token !== config.authToken) {
    ws.close(4001); // 认证失败
    return;
  }
  // ...
});
```
确认 `~/.pi/webui/config.json` 存在且含 `authToken`。

### 场景D：Vite 配置问题
检查 `ui/vite.config.ts`：
```typescript
export default defineConfig({
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
});
```

## 验证
```bash
/webui start
# 浏览器访问输出地址
# 确认：页面显示聊天界面、消息输入框、设备列表
# 发送测试消息确认 WebSocket 连通
```

## 关键文件
- `server.ts`：HTTP 服务器、静态资源服务、认证中间件
- `ws-hub.ts`：WebSocket 连接管理、设备在线状态广播
- `static/`：Vite 构建产物（index.html + assets/）
- `ui/`：前端源码（React + Vite）
- `~/.pi/webui/config.json`：服务配置（port/host/authToken）

## 相关命令
- `/webui start`：启动服务
- `/webui stop`：停止服务
- `/webui status`：查看设备在线状态
- `cd ui && npm run build`：构建前端产物
- `bash scripts/test-all.sh --only=pi-webui`：运行回归测试
