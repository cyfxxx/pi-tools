---
name: pi-backup
description: 备份/恢复 pi 配置、技能、扩展源码与用户数据（tar.gz 归档或 GitHub git 同步两种模式）。用户说"备份""存档""迁移""恢复""同步""推送"时触发。不适用：仅同步单个文件/临时传文件（用 scp/rsync）；不含配置的普通代码仓库同步。
version: v1.1
更新日期: 2026-09-12
---

# pi-backup 技能

备份/恢复 pi 配置、技能、扩展源码与用户数据。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用场景 | 备份/恢复 pi 配置、技能、扩展源码与用户数据 |
| 不适用 | 仅同步单个文件/临时传文件（用 scp/rsync）；不含配置的普通代码仓库同步 |
| 依赖 | tar, git, npm, rebuild.sh |

---

## 目录

- [一、概述](#一概述)
- [二、命令列表](#二命令列表)
- [三、备份清单](#三备份清单)
- [四、注意事项](#四注意事项)

---

## 一、概述

对 `~/.pi/` 下的 agent 配置、skills、扩展源码、SearXNG 配置文件等进行打包备份与恢复。支持两种模式：

- **本地归档**（`create` / `restore`）：tar.gz 压缩包，适合快照存档
- **GitHub 同步**（`sync` / `clone`）：git push/pull，适合日常增量同步

## 二、命令列表

- [`pi-backup create`](COMMANDS.md#pi-backup-create) — 创建本地 tar.gz 归档
- [`pi-backup sync`](COMMANDS.md#pi-backup-sync) — 推送到 GitHub（git commit + push）
- [`pi-backup restore`](COMMANDS.md#pi-backup-restore) — 从本地归档恢复到 `~/.pi/`
- [`pi-backup clone`](COMMANDS.md#pi-backup-clone) — 从 GitHub 克隆到 `~/.pi/`
- [`pi-backup rebuild`](COMMANDS.md#pi-backup-rebuild) — 重建被排除的可重建内容
- [`pi-backup verify`](COMMANDS.md#pi-backup-verify) — 体检：git 卫生 / 密钥泄漏 / 冒烟测试
- [`pi-backup list`](COMMANDS.md#pi-backup-list) — 列出可用备份 / 检查状态

## 三、备份清单

> 完整三表（始终包含 / 默认排除（`--full` 时额外包含） / 按需包含）见 `references/BACKUP-MANIFEST.md`。
> create/restore/clone 执行前先读该文件确认覆盖范围与重建方式。

## 四、注意事项

1. **敏感数据**：`auth.json` 包含 API 密钥，默认不包含在备份中。`git sync` 时 `.gitignore` 会自动排除它——但仍建议定期确认 `git ls-files agent/auth.json` 为空，防止意外追踪。
2. **重启生效**：恢复或克隆后必须重启 pi 才能加载更新后的配置。
3. **恢复前快照**：每次 `restore` 操作会自动创建 `~/.pi/pre-restore-{timestamp}.tar.gz`，可用于回滚。
4. **跨机器恢复**：`settings.yml` 中的 SearXNG secret_key 是安装时生成的。跨机器恢复后需要重新生成。
5. **重建超时**：`npm install` 在网络慢时可能超时。建议在网络稳定的环境下执行 `rebuild`。
6. **crontab 不包含在归档中**：使用 `crontab -l > pi-crontab.bak` 单独备份调度条目。恢复后运行 `bash scripts/install/install-cron.sh` 重建。
7. **调度任务文件**：`agent/extensions/pi-autopilot/scheduled-tasks.json` 已在备份清单中。如果恢复时该文件存在但扩展尚未安装，运行 `bash scripts/rebuild.sh --yes` 补装扩展依赖和 crontab。
8. **wrapper 恢复**：如果备份中包含了 pi-autopilot 扩展和 wrapper 脚本，恢复后建议运行 `~/.pi/scripts/install/install-wrapper.sh` 重新安装 wrapper，以启用自动重启能力。如果不需要自动重启，跳过此步骤即可。
9. **tmux 依赖**：pi-tmux 扩展与 pi 自身 TUI 依赖 tmux。恢复后 rebuild Phase 2-F2 自动同步 tmux 配置（tmux 命令本身不随 rebuild 自动安装，缺失时按系统包管理器手动安装）。若 tmux 缺失，pi-tmux 工具会返回安装指引错误。跨机器恢复注意系统差异（macOS 用 brew 且 `xclip` 绑定需改 `pbcopy`），见 `docs/alacritty-tmux-setup.md`。
10. **tmux 会话重连**：pi-wrapper.sh 支持 `PI_TMUX_SESSION=<名>` 环境变量把 pi 放进指定 tmux 会话（仅交互式生效），配合 tmux-resurrect 可持久恢复。设置该变量时确保不写入 `/etc/profile` 等全局位置，避免影响 pi-autopilot 子进程。
11. **多机 memory 冲突（P1）**：`memory/entries.json` 入库共享（已带环境标签，pi-memory 注入/检索自动过滤）；`notes.json`/`summaries.json` 已 git 忽略（会话级/环境特定，不入库）。多机交替 push/pull 时 entries.json 冲突处理：`git checkout --theirs memory/entries.json` 保留远程 → 本地重要新增从 stash/备份手工合并（pi-memory 会自动重新提取会话，一般无需手工）。详见 `docs/ENVIRONMENTS.md`。
12. **配置类文件跨机边界**：`settings.json`（主配置）、`models.json`（模型/密钥，pi ≥0.84 为 `models-store.json`）、`pi-voice.json`（whisper 令牌）均不在 git 同步范围内且默认不进归档。跨机迁移三选一：① `pi-backup create --with-auth` 打包 → restore；② scp 直接传；③ 新设备手动重建。`rebuild` 的验证阶段会探测缺失并给出对应指引（注意：旧脚本探测的是 `models.json`，pi ≥0.84 实际使用 `models-store.json`，以 `pi -p` 冒烟测试为准）。
13. **tsconfig 路径重写**：`rebuild` Phase 2-D 生成/重写**本机专属** `agent/extensions/tsconfig.local.json`（extends 共享 `tsconfig.json` + 本机 pi 安装根 paths；共享配置不含 paths，多环境不互相污染）。手动 `pi update` 换版本后再次运行 `rebuild.sh` 即可同步。
14. **PI_DIST（wrapper 后的 dist 定位）**：wrapper 接管 `pi` 命令后，补丁脚本（patch-*.mjs）与 pi-voice 的 dist 探测会解析到 wrapper 自身而失败——wrapper 已自动导出 `PI_DIST`（由解析出的 cli.js 推导）。直启 `pi-original` / node cli.js 时需手动：`export PI_DIST="$(dirname "$(readlink -f "$(which pi-original)")")"`。缺失时 pi-voice 加载报 `Extension runtime not initialized`，pi 完全无法启动（本次重建实测）。
15. **端到端冒烟测试**：重建/恢复后必须跑 `timeout 90 pi -p "回复 OK"`——它验证扩展加载（最易出错的一环）与模型链路，比单项检查更能暴露 wrapper/PI_DIST/扩展兼容问题。
16. **`pi-backup verify`**：同步前先跑体检（git 卫生/密钥泄漏/`.gitignore` 完整性），防止 `rsync` 式同步丢了 `.gitignore` 后把密钥提交进仓库（本次重建曾遇到，靠事后 `git rm --cached` 才救回）。

---

## 使用后改进（必做）

任务收尾时清点：执行过程与本文步骤/路径/结论的偏差。有 → 追加一条到 `improvements.md`（证据导向：命令、路径、现象，不直接改正文）。未合并条目 ≥3 条或用户要求时，合并进正文并清日志。机制全文见 `docs/SKILLS-MAINTENANCE.md`。
