# 备份清单（始终包含 / 默认排除 / 按需包含）

> 原位于 SKILL.md 正文，外置至此。执行 create/restore/clone 前先读本文件确认覆盖范围，再决定 --full/--with-auth 等参数。


### 始终包含（默认模式）

| 分组 | 相对路径 | 说明 |
|------|----------|------|
| 核心配置 | `agent/settings.json` | 主配置：provider、model、extension 设置 |
| 核心配置 | `agent/trust.json` | 项目信任设置 |
| 核心配置 | `agent/AGENTS.md` | agent 描述文件 |
| 核心配置 | `agent/APPEND_SYSTEM.md` | 追加系统提示词 |
| 技能 | `agent/skills/*/` | 所有已安装技能（SKILL.md 及附属文件） |
| 扩展源码 | `agent/extensions/*/` | 扩展源码，排除 `node_modules/`、`dist/`、`.git/` |
| 扩展冲突测试 | `agent/extensions/tests/` | conflict-check 等扩展级测试脚本 |
| 共享库 | `agent/lib/` | 共享库源码（context-budget/token-budget/prune/note-store/TOKEN-BUDGET.md） |
| 子代理定义 | `agent/agents/` | 子代理模板（scout/worker/reviewer.md） |
| Prompt 模板 | `agent/prompts/` | pi 全局 prompt templates（`*.md` 注册为 `/name` 斜杠命令） |
| 用户键位 | `agent/keybindings.json` | pi 用户级键位配置（存在时） |
| 开发文档 | `docs/` | 开发/部署文档（TERMUX-DEV-NOTES、PI-EXT-DEV-NOTES、PI-SDK-EXTENSION、alacritty-tmux-setup、ENVIRONMENTS） |
| 便携包脚本 | `portable/` | Windows 便携 pi 种子（bin/ 管理脚本 + start 入口 + ca-bundle + tmux shim，不含 .pi 密钥内容；完整便携包见 memory「便携 pi Windows 最终架构」） |

| npm 配置 | `agent/package.json` | npm 包声明 |
| 仓库配置 | `.gitignore` | git 忽略规则 |
| 仓库文档 | `README.md` | 说明文档 |
| 记忆 | `memory/` | pi-memory 持久记忆数据（如存在；已含原 ctx-lite 数据） |
| SearXNG 配置 | `searxng/settings.yml` | SearXNG 配置文件（含 secret_key） |
| SearXNG 脚本 | `searxng/start.sh`、`searxng/stop.sh` | 启停脚本 |
| 调度任务 | `agent/scheduled-tasks.json` | 定时任务定义（扩展与 cron 共享） |
| 调度脚本 | `scripts/pi-cron.sh` | cron 包装脚本（离线执行） |
| pi-link 设备清单 | `pi-link.json` | 多设备互联配置（host/user/port，gitignored 每环境独立，归档必须带走） |
| pi-link 公钥合集 | `deploy/keys/authorized_keys` | 所有设备公钥合集（git 入库；clone 后需 `pi-link-keys.sh install` 装到本机） |
| pi-link 加固入口 | `scripts/pi-link-entry.sh` | ssh forced command 加固入口（每设备需 `install-wrapper` 类机制装到 sshd） |
| pi-link 密钥脚本 | `scripts/pi-link-keys.sh` | 公钥 install/export/add（新设备接入流程） |
| 部署配置 | `deploy/systemd/` | systemd unit 模板（pi-searxng/pi-whisper，`%PI_HOME%` 占位；rebuild.sh 安装时替换） |
| 调度安装脚本 | `scripts/install-cron.sh`、`scripts/install-systemd.sh` | crontab / systemd 安装 |
| 生命周期脚本 | `scripts/pi-wrapper.sh` | 进程外生命周期管理器（自动重启） |
| 生命周期安装脚本 | `scripts/install-wrapper.sh` | wrapper 安装/卸载 |
| 生命周期直启脚本 | `scripts/pi-orig.sh` | 绕过 wrapper 直接启动（故障逃生） |
| 全局重建脚本 | `scripts/rebuild.sh` | 一键重建依赖（npm、venv、二进制） |
| 回归测试脚本 | `scripts/test-all.sh` | 一键全量回归（测试+类型+冲突检查） |
| 重建回归脚本 | `scripts/docker-rebuild-test.sh` | Docker 干净环境重建回归（clone→rebuild→判定） |
| 核心补丁 | `scripts/patch-*.mjs`（8 个：voice-enter/footer-live-context/plan-tools/tab-arg-completion/playwright-core/footer-cache/footer-format/footer-restart-hint） | rebuild.sh Phase 3 自动执行；**漏备份则 restore 后 rebuild 无法打补丁** |
| 用量基准 | `scripts/pi-bench.sh` | usage/timing/compare 基准工具 |
| 后台任务脚本 | `scripts/pi-bg.sh` + `scripts/README-pi-bg.md` | 后台任务四件套隔离 + 文档 |
| 冒烟测试 | `scripts/smoke-test.sh` | rebuild 依赖其第 1 项 |
| Termux 前置 | `scripts/termux-prereq.sh` | Termux 前置依赖安装（rebuild 依赖） |
| 多环境文档 | `docs/ENVIRONMENTS.md` | 多环境识别/切换流程/数据隔离表 |
| Whisper 服务脚本 | `scripts/pi-whisper.sh` | 语音转写常驻服务管理（start/stop/status） |
| Whisper 服务源码 | `scripts/whisper-server.py` | faster-whisper HTTP 转写服务（127.0.0.1:18766；venv/模型可重建） |
| SearXNG 生成脚本 | `searxng/generate-config.sh` | 自动生成 settings.yml（含 secret_key） |
| tmux 配置 | `deploy/tmux/tmux.conf` | tmux 键位/插件/持久化配置副本（源 `~/.tmux.conf`；git 同步直接携带，WSL2 调优见 docs/alacritty-tmux-setup.md） |
| Alacritty 配置 | `deploy/tmux/alacritty.toml` | 终端渲染配置副本（源 `~/.config/alacritty/alacritty.toml`，存在时收录） |
| Termux 配置 | `deploy/tmux/termux.properties` | Termux 键盘栏 extra-keys 等副本（源 `~/.termux/termux.properties`，存在时收录；语音快捷键依赖） |
| tmux 部署文档 | `docs/alacritty-tmux-setup.md` | WSL2/Alacritty 部署问题与修复汇总 |
| tmux 运行数据目录 | `logs/tmux/` | pi-tmux 会话日志（运行时数据，默认排除且 `--full` 也不纳入） |
| tmux 会话注册表 | `agent/.pi-tmux-registry.json` | pi-tmux 会话元数据（名称/日志路径/命令；tmux 会话不可跨机恢复，运行时数据） |
| pi-link 运行时 | `pi-link-active.json`、`pi-link-state.json`、`pi-link-outbox.json` | 活跃时间戳/远程状态/信箱（每设备运行时数据，与 memory 同类隔离，不随 git 同步） |

> **tmux/Termux 配置收录方式**：外部配置（`~/.tmux.conf`、`~/.config/alacritty/alacritty.toml`、`~/.termux/termux.properties`）以副本形式收在仓库内 `deploy/tmux/` 目录——**git 同步（sync/clone）直接携带**，本地归档也直接收录 `deploy/tmux/` 目录（不再单独收集外部路径）；`restore`/`clone` 后写回原路径：
> ```
> cp ~/.pi/deploy/tmux/tmux.conf ~/.tmux.conf            # tmux 配置
> cp ~/.pi/deploy/tmux/termux.properties ~/.termux/      # Termux 键盘栏（Termux 环境）
> cp ~/.pi/deploy/tmux/alacritty.toml ~/.config/alacritty/  # Alacritty（若存在）
> ```
> 均"存在时收录"，缺失自动跳过。外部源文件更新后需手动同步回 `deploy/tmux/` 再提交（`cp ~/.tmux.conf ~/.pi/deploy/tmux/tmux.conf && git add deploy/tmux/ && git commit`）。



### 默认排除（`--full` 时额外包含）

| 分组 | 相对路径 | 说明 | 重建方式 |
|------|----------|------|---------|
| 会话 | `agent/sessions/` | 对话历史（可能含隐私） | 不可重建，需通过 `--include-sessions` 恢复 |
| npm 依赖 | `agent/node_modules/` | npm 包（统一依赖根，10 扩展共享） | `cd ~/.pi/agent && npm install` |
| 运行时二进制 | `agent/bin/` | fd、rg | 自动下载 |
| Python 虚拟环境 | `searxng/venv/` | SearXNG Python 依赖 | `python3 -m venv venv && pip install` |
| SearXNG 源码 | `searxng/repo/` | SearXNG 原始项目 | `git clone` |
| 日志 | `searxng/searxng.log` | 运行时日志 | 不可重建，不恢复 |
| 调度日志 | `logs/scheduler/` | 离线执行日志 | 不可重建，不恢复 |
| npm lock | `agent/package-lock.json` | npm 锁定文件 | 由 `npm install` 生成 |
| 扩展 lock | `agent/extensions/*/package-lock.json` | 扩展 npm 锁定文件 | 由 `npm install` 生成 |
| 运行时缓存 | `context-mode/` | 上下文模式缓存 | 不可重建，不恢复 |
| 计划文件 | `plans/` | pi 自动生成的计划 | 不可重建，不恢复 |
| 运行时状态 | `agent/.pi-admin-state.json` | pi-autopilot 重启状态标记（wrapper 契约） | 不可备份恢复 |
| 自主运行状态 | `agent/.pi-autopilot-config.json`、`.pi-autopilot-telemetry.json`、`.pi-autopilot-lastgood.json`、`.pi-autopilot-crash.json` | pi-autopilot 配置/遥测/回滚快照 | 可重建，不恢复 |
| 模型配置 | `agent/models.json`（pi ≥0.84 为 `agent/models-store.json`） | provider/模型定义（机器特定，含 provider 密钥） | 默认不备份（与 settings.json 一同漏出会导致新设备无可用模型），需备份用 `pi-backup create --with-auth`；新设备经 scp 或 restore 提供 |

### 按需包含

| 分组 | 相对路径 | 说明 |
|------|----------|------|
| auth | `agent/auth.json` | API 密钥。**默认不包含**，需 `--with-auth` 确认。包含后应提醒用户注意安全。 |
| 语音配置 | `agent/pi-voice.json` | pi-voice 扩展配置（含 `whisperToken` 共享令牌）。**默认不包含**，随 `--with-auth` 一并收录（whisper 服务端与扩展同源读取该令牌，服务端依赖此文件鉴权）。 |
| 模型配置 | `agent/models.json`（pi ≥0.84 为 `agent/models-store.json`） | provider/模型定义（含密钥，属机器特定配置）。**默认不包含**，随 `--with-auth` 一并收录；否则新设备需手动提供。 |

---
