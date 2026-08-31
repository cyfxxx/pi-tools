# 本地实测笔记（WSL2 环境）

> 本文件为本地补充文档，不属于上游 wechatide-skill v0.3.9 原始内容。记录 2026-08 首次全流程打通的实测经验。

## 环境约定

- pi 运行在 WSL2；微信开发者工具装在 Windows：`D:\App_I\微信web开发者工具\`
- CLI 从 WSL 经 interop 调用：`cd /mnt/d && cmd.exe /c "App_I\微信web开发者工具\wechatide.cmd" -c pi <tool>`
- cwd 不能是 UNC 路径（`\\wsl.localhost\...`），否则 cmd.exe 报错，先 cd 到 /mnt/<盘>
- powershell 工具仅在 Windows 原生可用；WSL 内用 cmd.exe interop 替代
- 启动 IDE：`nohup <exe> &` 可行；`cmd start` 会拒绝访问
- 进程名是中文「微信开发者工具.exe」，tasklist 后 grep 英文（wechat/devtools）匹配不到，须 grep 中文或 iconv GBK

## CONNECT_ERROR 根因与修复

现象：auth 能成功（alreadyTrusted:true），但一切业务工具报 `CONNECT_ERROR: Failed to connect to WechatIDE`；cli.bat 报 ENOENT 无法写 `.cli`；而 MCP 服务实际健康（`curl http://127.0.0.1:20057/mcp/heartbeat` → `{"ok":true,...}`）。

根因：CLI 把 `global.userDirPath` 硬编码到旧版路径 `%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\Default\`，新版 IDE 数据实际在 `%APPDATA%\Roaming\微信开发者工具`。标记文件从未生成 → CLI 无法发现服务端口。属工具自身 bug。

修复（读 cli/index.js 定位的三文件语义）：

```bash
d="/mnt/c/Users/cyf/AppData/Local/微信开发者工具/User Data/3e1a0df395a953b9e71d2fe366549775/Default"
mkdir -p "$d"
echo -n "On" > "$d/.ide-status"   # 必须为 On，否则判定服务端口关闭
echo -n "20057" > "$d/.ide"       # netstat 查到的 LISTENING 端口
```

hash 目录名以 CLI 报错文本给出的为准。IDE 重装/换端口后需同步更新 `.ide` 内容。

## 已验证的完整调用链

```bash
# 门禁（versionRelation=equal 且 loginExpired=false 才可继续业务）
wechatide.cmd -c pi check_wechatide_status --skill-version 0.3.9
# 导入项目（Windows 路径）→ 开窗 → 推送预览到登录工具的微信
wechatide.cmd -c pi project_import --project "D:\projects\todo-demo"
wechatide.cmd -c pi open_project_window --project "D:\projects\todo-demo"
wechatide.cmd -c pi auto_preview --project "D:\projects\todo-demo"
```

实测项目：todo-demo（单页待办清单，AppID wxebe9875985c7bff8，代码包 4.3KB 编译通过，手机端增删+本地存储持久化正常）。

## 注意事项

- auth/login 类 pending 任务按规范主动轮询（10s×10 次）；其余 pending 只提醒用户在 IDE 内确认，禁止重发原操作
- tokenRequired:false 时无需 CLI 令牌；若未来开启，令牌从 IDE「设置→安全」获取，不入库不打日志
- AppSecret 与小程序前端无关，不得写入任何 git 跟踪文件

## 2026-08-31 CLI 通用要点（迁自长期记忆，补充实测覆盖）

- wechatide-skill 依赖 wechatide CLI：CLI 未装时技能命令直接失败，应先 `<cli> --version` 确认就绪再跑技能命令。
- 微信开发者工具原生 CLI：Windows 位于安装目录下的 cli.bat（macOS 为 cli 二进制），首次使用必须在开发者工具「设置 → 安全设置」开启「服务端口」，否则 CLI 连接被拒。
- 官方 CLI 文档：https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html ；小程序注册（获取 AppID）https://mp.weixin.qq.com ；开发者工具下载 https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html 。
- 2026-08-26 完成 CLI 安装并冒烟验证通过，链路可用。
