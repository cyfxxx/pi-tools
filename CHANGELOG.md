# 版本发布记录

主线（master）稳定版本锚点。每个稳定版本打 tag（`stable-YYYYMMDD`），出现问题时可用
`git checkout <tag>` 回退，或从该 tag 拉分支修复（便携版开发走 portable-win 分支，见下）。

## stable-20260814（主线 v1 稳定版）

**tag**: `stable-20260814`（对应提交 `331eeb2` 之后，含 2026-08-14 全部主线修复）

**定位**: 多环境（Termux/WSL2/Linux/macOS）日常运维基线。本版本之前完成：

### 功能主线
- pi-link 多设备互联：T1 会话连续性 / T2 五项（in-flight 锁、outbox、状态文件、指令模板、附件探测）+ 并发 attach 竞态修复（串行化 + buffer 唯一化）+ altHosts 局域网 failover
- pi-voice：/voice device 切换、录音就绪提示、whisper 孤儿进程兜底、benchmark 真 5s、shutdown 补 -q
- 第三台设备 termux-phone 接入，全链路验证

### 2026-08-14 全项目审计修复（21 项）
- HIGH：probeAddr 永久挂起（ENOENT 锁泄漏）、isSafeCommand 三绕过（find -delete / sed w / curl --output=）
- MEDIUM：storage 写互斥、telemetry tmp 竞态、fireViaMessage 误记 success、subagent 超时分类、headless 权限、attach tmp 唯一化、onEvent 防护、stderr cap、readOutput 尾读等

### 便携版分支（separate）
Windows 便携版构建（24 个提交）全部在 **portable-win** 分支，不进入主线。已 cherry-pick 回主线的通用部分：
- pi-voice 加载期 stub 崩溃修复 + windows 类型增量
- pi-browser cloakbrowser peer 依赖显式声明
- 仓库目录整理 keys/systemd/tmux → deploy/
- pi-backup 备份清单 + .gitignore 防便携密钥误提交

### 目录结构变更（自本版本起）
- `keys/` `systemd/` `tmux/` → `deploy/{keys,systemd,tmux}/`（脚本引用已全部更新）
- 本机 `~/.tmux.conf` 需重新同步：`cp ~/.pi/deploy/tmux/tmux.conf ~/.tmux.conf`

### 回退/分支指引
- 回退到本版本：`git checkout stable-20260814`
- 便携版开发：`git checkout portable-win`
- 从本版本拉修复分支：`git checkout -b fix/xxx stable-20260814`
