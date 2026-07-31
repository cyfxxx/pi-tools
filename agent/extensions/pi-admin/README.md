# pi-admin

Agent 自管理扩展。让 AI 模型能够控制 Pi Agent 本身——切换模型、切换会话、修改配置、重启程序。

## 工具

| 工具名 | 功能 | 需重启 |
|--------|------|--------|
| `admin_status` | 查看 Agent 当前状态 | 否 |
| `admin_list_models` | 列出所有可用模型 | 否 |
| `admin_set_model` | 切换模型（自动重启） | 是 |
| `admin_get_config` | 读取配置项 | 否 |
| `admin_set_config` | 修改配置项 | 否 |
| `admin_list_sessions` | 列出可用会话 | 否 |
| `admin_switch_session` | 切换到指定会话（自动重启） | 是 |
| `admin_restart` | 重启 Agent | 是 |

## 命令

| 命令 | 功能 |
|------|------|
| `/admin:status` | 显示 Agent 状态 |
| `/admin:restart [reason]` | 重启 Agent |
| `/admin:session <id>` | 切换会话（优先热切换，失败才重启） |
| `/admin:model <provider> <model>` | 切换模型 |
| `/admin:config <key> [value]` | 读取/修改配置 |

## 工作原理

### 重启协议

需要重启的操作（切换模型/显式重启；切换会话在热切换不可用时兜底）通过状态文件 `~/.pi/agent/.pi-admin-state.json` 实现：

```
extension 写状态文件 → ctx.shutdown()
                              ↓
        pi-wrapper.sh 检测到退出 → 读状态文件
                              ↓
        构建 CLI 参数 (--continue / --session / --model)
                              ↓
        重新执行 pi，重置 action="none" 防循环
                              ↓
        session_start 时注入恢复消息 → AI 继续任务
```

`/admin:session` 命令优先调用 `ctx.switchSession()` 热切换（不重启）；仅在调用抛异常时回退到写状态文件 + 重启。

### 安装 wrapper

```bash
~/.pi/scripts/install-wrapper.sh
```

wrapper 将原 `pi` 命令备份为 `pi.orig`，用包装脚本替代。卸载时恢复即可：
```bash
sudo cp $(which pi).orig $(which pi)
```

如果不安装 wrapper，需要重启的操作只会退出程序，不会自动拉起。
