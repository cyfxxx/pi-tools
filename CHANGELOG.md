# 版本发布记录

主线（master）稳定版本锚点。每个稳定版本打 tag（`stable-YYYYMMDD`），出现问题时可用
`git checkout <tag>` 回退，或从该 tag 拉分支修复。

## 2026-08-28 每日任务 v3 + 跨设备同步与修复

- **每日任务 v3 竞态容忍架构**（e8073f0）：查重主流程 + 交叉比对兑底，并发竞态下不丢条目
- **knowledge-fetch KLOG 路径修复**（a54e34a）：KLOG 改 HOME 环境变量解析，兼容 Termux/Linux
- **rebuild 清理残留 node_modules**（7357ac5）：npm 就绪后主动清除扩展残留独立依赖（幂等，仅删真实依赖，.vite 占位保留）
- **packs 新增 media-toolkit**（a9a8475）：图片/视频/游戏美术处理
- **pi-memory 提取子进程 --no-extensions**（d185267）：修复 -p 离线提取挂起超时

## 2026-08-27 OpenViking 设计借鉴：输出外置化 + 检索轨迹

- **pi-context 写入时截断外置化**：新增 lib/output-archive.ts——pruneToolOutput 预算截断时原文落盘 logs/tool-outputs/（sha256 内容 hash 命名，同内容同路径确定性），占位符附存档路径可 read 读回；fail-open。与 b798152 分层擦除 refs 机制（logs/prune-refs/ 会话级 md + sentinel 幂等 + 过期清理）分工：写入时预算裁剪 vs 历史轮事后擦除，两目录语义分离
- **pi-memory 检索轨迹台账**：memory_search/memory_recall 每次检索追加 agent/stats/memory-search.jsonl（query/命中 id+标题+得分/耗时，4MB 轮转一代），供排查「为什么没召回」；PI_MEMORY_TRACE_FILE 可覆盖
- **ROADMAP 4.5 观察项**：L0 分层注入（OpenViking 三层加载借鉴），触发条件为注入块接近预算或活跃条目 >800

## 2026-08-26 审计修复闭环 + packs 扩容

- 全项目审计修复闭环 v2（HIGH×2 + MEDIUM×14 + LOW×11）；压缩摘要暖前缀重放终态（onPayload 桥，机制 B）
- 缓存影响声明守门 + 评估隔离契约 + 蒸馏质检（dsh 生态借鉴三项）
- packs 新增 embedded-dev（嵌入式开发）、pcb-design（PCB 硬件设计）、wechatide-skill v0.3.9（小程序开发）
- pi-link 卡片 IP 探测打分选卡 + WSL ipconfig 解析；pi-autopilot 测试泄漏写真实 admin-state 根因闭环

## 2026-08-24 portable-win 并入 master

Windows 便携版专用分支 `portable-win` 的修复已全部并入主线（此前经测试分支合并 + 移植提交落地
master，含 pi-tmux Windows 原生后端、whisper/searxng 脱离 WSL、pi-browser 定制版适配、start.bat
junction 自愈等）。

- 远端分支 `portable-win` / `test/portable-win-merge` 已删除，便携版统一走 master
- `portable/bin/update-portable.ps1`：gh-proxy clone 分支 portable-win → master
- `portable/bin/sync.ps1`：分支 fallback 改为 master
- 便携包更新方式：代码 `git pull origin master`（SSH 443），本体 `bin/update-pi.ps1`（npm+npmmirror）

## stable-20260814（主线 v1 稳定版）

**tag**: `stable-20260814`（`331eeb2` 为历史重写前 hash，已作废，对应现 tag 指向提交；含 2026-08-14 全部主线修复）

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
