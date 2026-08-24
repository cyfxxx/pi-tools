---
name: pi-backup
description: 备份/恢复 pi 配置、技能、扩展源码与用户数据（tar.gz 归档或 GitHub git 同步两种模式）。用户说"备份""存档""迁移""恢复""同步""推送"时触发。。不适用：仅同步单个文件/临时传文件（用 scp/rsync）；不含配置的普通代码仓库同步。
version: v1.1
---

# pi-backup 技能

对 `~/.pi/` 下的 agent 配置、skills、扩展源码、SearXNG 配置文件等进行打包备份与恢复。支持两种模式：

- **本地归档**（`create` / `restore`）：tar.gz 压缩包，适合快照存档
- **GitHub 同步**（`sync` / `clone`）：git push/pull，适合日常增量同步

## 命令列表

- [`pi-backup create`](#pi-backup-create) — 创建本地 tar.gz 归档
- [`pi-backup sync`](#pi-backup-sync) — 推送到 GitHub（git commit + push）
- [`pi-backup restore`](#pi-backup-restore) — 从本地归档恢复到 `~/.pi/`
- [`pi-backup clone`](#pi-backup-clone) — 从 GitHub 克隆到 `~/.pi/`
- [`pi-backup rebuild`](#pi-backup-rebuild) — 重建被排除的可重建内容
- [`pi-backup verify`](#pi-backup-verify) — 体检：git 卫生 / 密钥泄漏 / 冒烟测试
- [`pi-backup list`](#pi-backup-list) — 列出可用备份 / 检查状态

---

## `pi-backup create`

创建本地 tar.gz 归档备份。

**参数：**

| 参数 | 说明 |
|------|------|
| `--output <path>` | 输出路径（默认见下方[备份目录约定](#备份目录约定)） |

> **备份目录约定**：Termux/Android 环境默认 `/storage/emulated/0/我的文件/pi-backup/`；其他环境默认 `~/pi-backups/`。归档文件名 `pi-backup-{hostname}-{timestamp}.tar.gz`。
| `--with-auth` | 包含 `auth.json`（API 密钥）及同源敏感配置 `pi-voice.json`（whisper 令牌）、`models.json`（provider 密钥）。默认不包含。 |
| `--full` | 包含 sessions、node_modules、venv、bin 等默认排除项 |
| `--keep N` | 保留最近 N 份备份（默认 5），超出则删除最旧的文件 |

**执行步骤：**

1. 如果未指定 `--with-auth`，**必须询问用户**是否包含 `auth.json`。
2. 在 `/tmp/` 下创建临时目录 `pi-backup-{timestamp}`。
3. 按[备份清单](#备份清单)将文件复制到临时目录（`--full` 时包含默认排除项）。
4. 同时写入 `manifest.json` 到归档内：
   ```json
   {
     "tool": "pi-backup",
     "mode": "local",
     "timestamp": "{ISO-8601}",
     "hostname": "{hostname}",
     "full": false,
     "has_auth": false,
     "files": ["agent/settings.json", "..."],
     "excluded": ["agent/node_modules/", "..."]
   }
   ```
5. 运行 `tar czf {output_path} -C /tmp/pi-backup-{timestamp}/ .`
6. 清理临时目录：`rm -rf /tmp/pi-backup-{timestamp}/`
7. 验证完整性：`tar tzf {output_path} | head -5` 检查可读。
8. 执行保留轮转：如果备份目录下同模式备份超过 `--keep N` 份（默认 5），删除最旧的。
9. 报告备份文件路径、大小、文件数量。

**示例输出：**

```
备份完成：/storage/emulated/0/我的文件/pi-backup/pi-backup-myhost-20260701_120000.tar.gz (1.4 MB)
包含 52 个文件（默认模式，不含 auth）
保留 5 份，已清理 0 份旧备份
```

---

## `pi-backup sync`

将当前 `~/.pi/` 的 git 追踪文件通过 commit + push 同步到 GitHub。

> **git 模式的边界（重要）**：`.gitignore` 排除了 `agent/settings.json`、`agent/models.json`、`agent/pi-voice.json`、`agent/auth.json`、`agent/trust.json`、`searxng/settings.yml` 等含密钥/机器特定配置——git 同步**不含**这些文件。新设备 `clone` 后需手动提供（见 [clone](#pi-backup-clone) 与 `pi-backup create --with-auth`）。

> **与本地归档（`create`）的差异**：git 同步只含入库文件；本地归档另含 gitignored 配置（`settings.json`/`trust.json`）与运行时数据（`memory/notes.json`/`summaries.json` 等）。git 缺失项均为刻意排除，各有替代路径：

> | 归档含但 git 不含 | 性质 | 替代路径 |
> |---|---|---|
> | `agent/settings.json`、`agent/trust.json` | 每环境独立配置（多环境约定） | clone 后 scp 或 `create --with-auth` 归档恢复 |
> | `memory/notes.json`/`summaries.json`（会话级记忆） | 运行时数据隔离（P1 决策） | `create` 归档全量带走 |
> | `searxng/settings.yml`（secret_key） | 机器特定 | `generate-config.sh` 一键重建 |
>
> 定位差异：**git = 配置骨架 + 源码增量同步**（不含密钥/会话）；**归档 = 全量快照**（含运行时数据）。换机完整迁移建议两者都用：`create --with-auth` 归档带走全部 + git 同步源码（见 [clone](#pi-backup-clone) 恢复流程）。

**参数：**

| 参数 | 说明 |
|------|------|
| `--message "msg"` | 自定义 commit 信息（默认 `pi-backup: {ISO-8601}`） |
| `--remote <name>` | 远程仓库名（默认 `origin`） |
| `--branch <name>` | 分支名（默认 `master`） |
| `--refresh-baseline` | 刷新 gitignored 配置变更基线（检测到配置变化且确认是有意修改后使用） |

**前置检查（优先执行，任一不通过则中止并报错）：**

1. 检查 `~/.pi/.git` 目录存在 → 否则报错 `~/.pi/ 不是 git 仓库`
2. 检查 `git remote` 已配置 → 否则报错 `未配置远程仓库，请先运行 git remote add`
3. 运行 `git remote -v` 检查 remote URL 可到达 → 否则报错 `远程仓库不可达`
4. 运行 `git status --porcelain` 检查是否有变更 → 若无变更则提示 `无变更需要同步`
5. **gitignored 配置变更检测**（基线对比）：`sha256sum agent/settings.json agent/models.json agent/models-store.json agent/pi-voice.json agent/auth.json searxng/settings.yml 2>/dev/null` 与 `.backup-baseline/ignored.sha256` diff 对比——有变化则警告：`以下配置自上次备份后有修改（不在 git 同步范围，跨机需 pi-backup create --with-auth 或 scp）`，确认是有意修改后运行 `--refresh-baseline` 刷新基线；基线不存在时自动创建
6. **外部配置副本差异检测**：`~/.tmux.conf` vs `deploy/tmux/tmux.conf`（及 `~/.termux/termux.properties` vs `deploy/tmux/termux.properties`，存在时）`cmp -s` 对比——不同则警告：`源文件有更新未同步回 deploy/tmux/`，提示 `cp` 后重新提交
7. 检查 `~/.pi/.gitignore` 存在且包含 `agent/auth.json`、`agent/settings.json`、`agent/models*.json`、`agent/pi-voice.json`、`searxng/settings.yml` 等排除规则 → 缺失则报错：`缺少 .gitignore（rsync/手工拷贝同步时最易丢失，先恢复它再同步，否则密钥会被提交！）`
8. 检查敏感文件是否被意外追踪：运行 `git ls-files`，检查 `agent/auth.json`、`agent/settings.json`、`agent/models.json`、`agent/models-store.json`、`agent/pi-voice.json`、`agent/trust.json`、`searxng/settings.yml` 是否出现在输出中——任一命中**立即报错中止**并给出移除指引：`git rm --cached <file> && git commit -m "remove secret"`

**执行步骤：**

0. 若指定 `--refresh-baseline`：运行 `sha256sum agent/settings.json agent/models.json agent/models-store.json agent/pi-voice.json agent/auth.json searxng/settings.yml 2>/dev/null > .backup-baseline/ignored.sha256` 刷新基线（基线目录已被 .gitignore 排除，不入库）
1. 运行 `git add -A`
2. 运行 `git commit -m "pi-backup: {timestamp}"`（可用 `--message` 覆盖）
3. 运行 `git push {remote} {branch}`
4. 打印推送结果的 commit hash、文件变更数统计：

```
GitHub 同步完成
  提交：a1b2c3d
  远程：origin → https://github.com/cyfxxx/pi-tools.git (master)
  变更：8 文件（5 修改、3 新增）
  时间：2026-07-01T12:00:00Z
```

---

## `pi-backup restore`

从本地 tar.gz 归档恢复到 `~/.pi/`。**会覆盖现有文件。**

**参数：**

| 参数 | 说明 |
|------|------|
| `--backup <path>` | 备份文件路径（默认列出可用备份供选择） |
| `--include-auth` | 恢复 `auth.json`（如果备份中包含） |
| `--include-sessions` | 恢复 `sessions/` 对话历史（默认跳过） |
| `--yes` | 静默模式：自动确认 + 自动重建全部依赖，不逐项询问 |
| `--no-rebuild` | 跳过依赖重建步骤，仅恢复文件 |

**执行步骤：**

**阶段 1：准备**

1. 如果未指定 `--backup`，列出备份目录下 `pi-backup-*.tar.gz`（目录见 create 节备份目录约定）并按时间排序，让用户选择。
2. 检查备份文件完整性：`tar tzf {backup_path} | head -1`，若失败则报错。
3. 显示差异摘要——列出备份中包含的目录和当前 `~/.pi/` 的差异概要。
4. 确认用户确要恢复。

**阶段 2：快照**

5. 创建恢复前快照（含当前机器全部可覆盖配置；文件不存在时自动跳过）：
   ```
   SNAPSHOT_PATH="~/.pi/pre-restore-{timestamp}.tar.gz"
   tar czf "$SNAPSHOT_PATH" --ignore-failed-read \
     -C ~ .pi/agent/settings.json .pi/agent/models.json .pi/agent/models-store.json .pi/agent/pi-voice.json \
        .pi/agent/AGENTS.md .pi/agent/APPEND_SYSTEM.md \
        .pi/agent/trust.json .pi/agent/skills .pi/agent/extensions .pi/agent/lib \
        .pi/agent/agents .pi/agent/prompts .pi/agent/package.json \
        .pi/memory .pi/searxng/settings.yml .pi/scripts \
        .tmux.conf .config/alacritty/alacritty.toml .termux
   ```

**阶段 3：解压**

6. 解压归档：`tar xzf {backup_path} -C ~/.pi/`（归档根为 `agent/ scripts/ memory/` 等，对应 `~/.pi/` 下的目录；解到 `~/` 会污染 home——审计 MEDIUM）
7. 验证关键文件：`ls -la ~/.pi/agent/settings.json` 等。
8. 如果备份中不含 `auth.json` 且未指定 `--include-auth`：告知用户 `auth.json` 未被恢复，当前文件保持不变。`pi-voice.json` / `models.json` 同理——未随备份提供时保持现状（`--with-auth` 创建的归档会包含它们）。

**阶段 4：重建依赖**

9. 除非指定了 `--no-rebuild`，否则运行[重建流程](#pi-backup-rebuild)（`--yes` 时自动全部执行，否则逐项确认）。

**阶段 5：报告**

10. 打印恢复摘要：

```
恢复完成
  来源：/storage/emulated/0/我的文件/pi-backup/pi-backup-myhost-20260701_120000.tar.gz
  文件：已解压 52 个
   重建：npm 依赖 ✓ | 扩展依赖 ✓ | fd/rg ✓ | SearXNG venv ✓ | tmux 环境 ✓
  跳过：sessions（未请求）| auth.json（备份中不含）
  快照：~/.pi/pre-restore-20260701_120500.tar.gz
  ⚠ 重启 pi 使更改生效
```

---

## `pi-backup clone`

从 GitHub 克隆配置到本地或拉取最新变更，然后重建被排除的依赖。

**参数：**

| 参数 | 说明 |
|------|------|
| `--repo <url>` | 仓库 URL（默认从已有 remote 拉取） |
| `--branch <name>` | 分支（默认 `master`） |
| `--include-auth` | 从已 clone 的仓库恢复 `auth.json`（仅当 auth.json 在仓库中时有效，通常不应勾选） |
| `--yes` | 静默模式，自动重建全部依赖 |

**执行步骤：**

1. 如果 `~/.pi/` 已存在：
   - 如果指定了 `--repo`：提示用户 `~/.pi/` 已存在，询问是否备份后覆盖。
   - 如果未指定 `--repo`：运行 `cd ~/.pi && git pull` 拉取最新。
2. 如果 `~/.pi/` 不存在且指定了 `--repo`：`git clone {url} ~/.pi`
   - **证书失败（CAfile: none）**：`git clone/pull` 报证书验证失败时（沙箱/代理网络拦截 TLS），改用 `git -c http.sslVerify=false clone {url} ~/.pi` 或 `git config --global http.sslVerify false`；也可先 `apt-get install -y ca-certificates && update-ca-certificates` 修复系统证书。
   - **`.gitignore` 检查**：clone 后确认 `~/.pi/.gitignore` 存在且含敏感文件排除规则——缺失时密钥有被提交风险（rsync/手工拷贝同步时该文件最易丢失），先从仓库恢复它再继续。
3. 验证 `~/.pi/agent/settings.json` 存在。
   - **注意**：git 同步不含 `settings.json` / `models.json` / `pi-voice.json`（受 `.gitignore` 排除）。新设备 clone 后若缺失，**需手动提供**，否则 pi 无可用模型无法启动对话：
     ```
     scp user@orig:~/.pi/agent/settings.json user@orig:~/.pi/agent/models.json ~/.pi/agent/
     # 语音扩展使用: scp user@orig:~/.pi/agent/pi-voice.json ~/.pi/agent/
     # 或从原机打包: pi-backup create --with-auth，新机 pi-backup restore
     ```
     缺失时 `rebuild` 的验证阶段会明确警告并给出上述引导。
4. 从 `deploy/tmux/` 写回外部配置（见[收录方式](#备份清单)的 `cp` 命令）：`~/.tmux.conf` 等缺失时执行，已存在则提示确认覆盖。

5. **pi-link 公钥安装**：`bash ~/.pi/scripts/pi-link-keys.sh install`（把 `deploy/keys/authorized_keys` 合并进本机 `~/.ssh/authorized_keys`，Termux 自动双写）——否则新设备无法被其他设备免密接入。
6. 运行[重建流程](#pi-backup-rebuild)（`--yes` 时自动全部执行，否则逐项确认）。
7. 告知用户重启 pi。

---

## `pi-backup rebuild`

重建所有被 git 排除的可重建内容。适用于恢复后、新克隆后、或依赖被误删后。

**参数：**

| 参数 | 说明 |
|------|------|
| `--yes` | 非交互式，自动重建全部项 |
| ~~`--china`~~ | **无此参数**（已由自动检测取代）：rebuild.sh 启动时 `detect_china_network()` 自动启用中国镜像（apt/npm/GitHub），无需也不支持手动指定；传入会忽略并警告 |
| `--voice` / `--no-voice` | 强制包含/跳过语音依赖重建（默认条件触发：`agent/pi-voice.json` 存在即重建） |
| `--whisper-model=<名>` | whisper 模型档位（tiny/base/small/medium/large-v3，默认 base） |
| `--no-gpu` | 跳过 CUDA 库安装提示（GPU 检测仍会输出提示，安装为可选） |
| `--no-piper` | 跳过 piper 神经 TTS 安装提示 |

**执行方式与进度报告（重要——防止长时间无反馈误判卡死）：**

1. 后台执行二选一（**先探测 `command -v tmux`**；重建场景可能恰好没有 tmux——它是 Phase 2-F2 的重建项）：
   - **有 tmux**：`tmux_run` 后台执行，输出落盘 `~/.pi/logs/tmux/<会话>.log`，轮询用 `tmux_read`。
   - **无 tmux**：用 `nohup` 后台执行并重定向日志：`mkdir -p ~/.pi/logs && nohup bash ~/.pi/scripts/rebuild.sh --yes > ~/.pi/logs/rebuild.log 2>&1 &`；轮询用 `tail -n 30 ~/.pi/logs/rebuild.log`（bash 直跑，不依赖 tmux）。记录 PID（`echo $!`）供卡死判定时 `kill -0` 探活。
   - 单条短命令（如 `mkdir`）可前台执行，但 npm/pip/git clone/模型下载必须后台。
2. **进度报告节奏：每 60 秒检查一次日志（tmux 用 `tmux_read`、无 tmux 用 `tail`），主动向用户输出一行进度**（用户没问也报告）：
   - 格式：`[重建进度 +3m12s] Phase 1/2 完成 ✓；当前：Phase 2-B searxng venv pip install（预估 5-15 分钟）；已完成 6/13 项`
   - 内容：已耗时、已完成 Phase（grep 日志 `[Phase` / `✓`）、当前进行项（日志最后活动行）、完成项计数（含跳过项）。
3. 单项耗时预估（超预估不必惊慌，按节奏报告即可；预估含中国网络减速）：

   | 重建项 | 预估 |
   |---|---|
   | npm install（agent/ 统一根） | 1-5 分钟 |
   | searxng venv + pip install 全量依赖 | 5-15 分钟 |
   | whisper 模型下载（base） | 2-10 分钟（档位越大越久） |
   | git clone（ghproxy 镜像） | 1-5 分钟 |
   | apt install | 1-3 分钟 |

4. **卡死判定**：日志 5 分钟无新增输出 → 主动报告「疑似卡住（X 分钟无新输出），正在检查」；用 `ps aux | grep -E "rebuild|npm|pip"`（无 tmux 时也可 `kill -0 <PID>`）确认进程存活、检查下载文件大小是否增长（`ls -l` / `du`），区分「慢」与「卡」；确认卡死才中止（有 tmux 用 `tmux_stop`，无 tmux 用 `kill <PID>`），否则继续等待并报告「仍在运行（正常）」。
5. 完成后汇总报告：总耗时 + 各 Phase ✓/跳过 + 验证结果（格式见下方示例输出）。

**前置检查（在重建前执行一次）：**

| 检查项 | 条件 | 操作 |
|--------|------|------|
| Node.js 版本 | `< 20` | 使用 NodeSource 安装 Node.js 22.x |
| Python venv（ensurepip） | `python3 -m venv /tmp/.venv-probe` 创建失败 | Debian/Ubuntu 按实际版本装 `python3.12-venv`（`dpkg -l python3-venv` 显示已装但可能是空壳）；删掉失败的 `searxng/venv/` 后重跑 rebuild |
| pip 镜像 | 自动检测到中国网络 | `pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple` |
| npm 镜像 | 自动检测到中国网络 | `npm config set registry https://registry.npmmirror.com` |
| GitHub 镜像 | 自动检测到中国网络 | 所有 `github.com` 下载通过 `ghproxy.net` 代理 |
| apt 镜像 | 自动检测到中国网络 | 替换 `/etc/apt/sources.list.d/ubuntu.sources` URIs 为清华源 |

**重建清单（并发组间顺序执行，组内并行）：**

**Phase 1 — 配置补全（顺序）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 0 | `searxng/settings.yml` | 文件不存在或缺少 `secret_key` | `cd ~/.pi/searxng && bash generate-config.sh 2>&1` |
| 1 | `agent/package.json` | 文件不存在（统一依赖根声明，10 扩展共享） | 从 git 恢复（`agent/package.json` 入库）；`settings.json` 中 `packages` 引用由 rebuild.sh Phase 1 自动合并进其 dependencies |
| 2 | `~/.pi/agent/bin/` | 目录不存在 | `mkdir -p ~/.pi/agent/bin` |

**Phase 2 — 并行组 A（npm 依赖）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 3 | `agent/node_modules/` | 存在 `agent/package.json` 且目录不存在或为空 | `cd ~/.pi/agent && npm install 2>&1`（全量含 dev 工具，供测试/类型检查） |

**Phase 2 — 并行组 B（Python 环境）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 5 | `searxng/venv/` | `searxng/settings.yml` 存在且 `searxng/venv/bin/python` 不存在 | `cd ~/.pi/searxng && python3 -m venv venv && venv/bin/pip install -r searxng/repo/requirements.txt 2>&1`（全量依赖） |
| 6 | `searxng/repo/` | `searxng/repo/` 不存在或为空 | `git clone --depth 1 https://github.com/searxng/searxng ~/.pi/searxng/repo 2>&1`（中国网络通过镜像代理） |

**Phase 2 — 并行组 B2（Whisper 转写服务，条件触发）：**

> **触发条件**：`agent/pi-voice.json` 存在（该机配置过语音，文件本身是 git 排除的机器配置）→ 自动重建；`--voice` 强制包含；`--no-voice` 强制跳过（如无麦克风的服务器）。跳过时输出提示，不装任何语音依赖（防多余）。

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 6a | `/opt/pi-whisper/venv/` | 语音条件满足且 venv 缺失 | `python3 -m venv /opt/pi-whisper/venv && /opt/pi-whisper/venv/bin/pip install faster-whisper opencc-python-reimplemented`（opencc 缺失时中文转写输出繁体；中国网络用清华 pypi 镜像） |
| 6b | Whisper 模型 | 语音条件满足且 `/opt/pi-whisper/models` 为空 | `HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 /opt/pi-whisper/venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('<模型>', device='cpu', compute_type='int8', download_root='/opt/pi-whisper/models')"`（模型档位由 `--whisper-model` 指定，默认 base；检测到 GPU 时提示可换更大档位） |
| 6c | GPU 推理（可选） | linux 且 `nvidia-smi` 存在且 ctranslate2 报 CUDA 不可用 | 提示安装：`/opt/pi-whisper/venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12`（约 500MB，`--no-gpu` 跳过；装后 whisper 自动 cuda/float16） |
| 6d | TTS 依赖（linux） | `espeak-ng` 或 `paplay` 缺失 | `apt-get install -y espeak-ng pulseaudio-utils`；piper 神经 TTS（自然中文，63MB）可选提示（`--no-piper` 跳过，安装见 pi-voice README） |
| 6e | TTS 依赖（termux） | termux 平台 | 提示手动 `pkg install termux-api`（rebuild 无法代跑 Android 侧） |

**Phase 2 — 并行组 C（二进制下载，并发执行）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 7 | `agent/bin/fd` | `fd` 命令不可用 | `apt-get install -y fd-find 2>&1` 并软链到 `~/.pi/agent/bin/fd` |
| 8 | `agent/bin/rg` | `rg` 命令不可用 | `apt-get install -y ripgrep 2>&1` 并软链到 `~/.pi/agent/bin/rg` |

**Phase 2-D — 扩展类型链接（顺序，需 pi 已安装）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 8a | `agent/extensions/tsconfig.local.json` paths | paths 指向的 pi 安装根与实际不符（或指向不存在的 `current`） | 自动扫描 `~/.local/share/pi-node/`（优先 `current` 解析，回退最高版本）并把 `/lib/node_modules/` 前缀重写到实际安装根 |

> **为何需要**：tsconfig paths 硬编码了 pi 官方类型的绝对路径，不同设备/版本的 node 安装根不同，不重写则扩展 `tsc` 类型检查失败。pi 未安装时跳过并警告，装好 pi 后重跑 `rebuild` 即可补齐。

**Phase 2-E — Pi wrapper 自愈（幂等）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 8b | wrapper shim（`pi` → pi-wrapper.sh） | npm 重装 pi 覆盖了 `bin/pi` | `bash ~/.pi/scripts/install-wrapper.sh --ensure --quiet`（重装 shim，`pi-original` 保留） |

**Phase 2-F — 语音服务（条件触发，见 B2 说明）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 8c | whisper 服务启动 | 语音条件满足且 venv 与 `/opt/pi-whisper/models` 均就绪（6a/6b 完成） | `bash ~/.pi/scripts/pi-whisper.sh start`（已运行则跳过；token/device 从 `agent/pi-voice.json` 读取；GPU 检测在 6c） |
| 8d | pi-link 互连公钥 | `scripts/pi-link-keys.sh` 与 `deploy/keys/authorized_keys` 存在 | rebuild.sh Phase 2-F3 自动执行 `pi-link-keys.sh install`（幂等：合并到 `~/.ssh/authorized_keys`，Termux 双写 proot+Termux 位置） |

**Phase 2-F2 — tmux 配置同步（跨系统兼容，单独一组）：**

tmux 是 pi-tmux 扩展与 pi 自身 TUI 的运行依赖。系统包管理器不同，重建命令需按发行版选择：

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 9 | `tmux` 命令 | `tmux -V` 失败 | 按系统安装：`apt-get install -y tmux`（Debian/Ubuntu）\| `dnf install -y tmux`（Fedora/RHEL）\| `pacman -S tmux`（Arch）\| `zypper install tmux`（openSUSE）\| `brew install tmux`（macOS） |
| 10 | `~/.tmux.conf` | 文件不存在 | 从仓库 `deploy/tmux/tmux.conf` 写回（`cp ~/.pi/deploy/tmux/tmux.conf ~/.tmux.conf`）；缺失则提示手动重建（含 WSL2 专属调优，见 `docs/alacritty-tmux-setup.md`） |
| 11 | tmux 插件（tpm/resurrect/continuum） | 不重建（仓库不包含插件源码） | 仅同步 `~/.tmux.conf`（上项）；插件需手动安装：`git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm && ~/.tmux/plugins/tpm/bin/install_plugins` |

> **跨系统兼容要点**：
> - **WSL2（当前环境）**：Alacritty 渲染需 `GALLIUM_DRIVER=d3d12`、`unset WAYLAND_DISPLAY`（wrapper 在 `/usr/bin/alacritty`）；tmux 用 `apt` 安装。详见 `docs/alacritty-tmux-setup.md`。
> - **原生 Linux**：无需 Wayland unset，包管理器按发行版（apt/dnf/pacman/zypper）。
> - **macOS**：`brew install tmux`；`~/.tmux.conf` 中 `xclip` 绑定需替换为 `pbcopy`。
> - 不同系统 tmux 会话恢复依赖 `tmux-resurrect` 快照目录 `~/.local/share/tmux/resurrect`（不跨机器复制，恢复后需重新保存快照）。
> - tmux 缺失时 pi-tmux 扩展会返回可安装指引错误，重建即修复。

**不重建的项（始终跳过）：**

- `agent/sessions/` — 对话历史无法重建，如需保留应使用 `--include-sessions` 参数恢复
- `agent/auth.json` — API 密钥无法自动重建，需用户手动创建或从备份恢复
- tmux-resurrect 快照（`~/.local/share/tmux/resurrect/`）与 `~/.tmux/plugins/` — 插件可重装、快照属本机运行时数据，均不纳入归档

**验证步骤（每项重建后执行）：**

| 验证项 | 命令 |
|--------|------|
| npm 依赖 | `ls ~/.pi/agent/node_modules/ 2>/dev/null \| wc -l` |
| 扩展依赖 | `for d in ~/.pi/agent/extensions/*/; do [ -d "$d/node_modules" ] && echo "$d OK" \|\| echo "$d MISSING"; done` |
| fd | `fd --version 2>/dev/null \|\| echo "fd not available"` |
| rg | `rg --version 2>/dev/null \|\| echo "rg not available"` |
| SearXNG venv | `~/.pi/searxng/venv/bin/python --version 2>/dev/null \|\| echo "venv not found"` |
| SearXNG repo | `[ -d ~/.pi/searxng/repo/.git ] && echo "OK" \|\| echo "MISSING"` |

| settings.yml | `python3 -c "import yaml; yaml.safe_load(open('$HOME/.pi/searxng/settings.yml'))" 2>/dev/null \|\| echo "YAML 校验失败"` |
| settings.json | `python3 -c "import json; json.load(open('$HOME/.pi/agent/settings.json'))" 2>/dev/null \|\| echo "JSON 校验失败"` |
| 扩展完整性 | `for d in "$HOME/.pi/agent/extensions"/*/; do [ -d "$d" ] && { case "$(basename "$d")" in tests\|node_modules\|types) continue;; esac; [ -f "$d/index.ts" ] \|\| echo "$(basename "$d") MISSING"; }; done`（动态扫描，新扩展免维护；`types/` 为类型声明目录，非扩展） |
| 类型链接 | `grep -q "$(readlink -f ~/.local/share/pi-node/current 2>/dev/null \|\| ls -d ~/.local/share/pi-node/*/ 2>/dev/null \| tail -1)" ~/.pi/agent/extensions/tsconfig.local.json \|\| echo "tsconfig paths 过期"`（`rebuild` Phase 2-D 自动同步；paths 在本机生成的 `tsconfig.local.json`，共享 `tsconfig.json` 不含 paths） |
| wrapper 自愈 | `bash ~/.pi/scripts/install-wrapper.sh --ensure --quiet`（幂等重装 shim，`pi-original` 保留） |
| 端到端冒烟测试 | `timeout 90 pi -p "回复 OK"`——输出 `OK` 且 exit 0 即全部扩展加载成功 + 模型链路可用；失败会指明具体扩展（如 pi-voice 报 `Extension runtime not initialized` 时检查 `PI_DIST`，见注意事项 13） |
| whisper 服务 | `bash ~/.pi/scripts/pi-whisper.sh status`（输出"运行中"或重启后首用自动加载） |
| 语音跳过提示 | `bash ~/.pi/scripts/rebuild.sh --yes`（无 `pi-voice.json` 时输出"跳过 whisper/语音依赖"一行提示，确认不装多余） |

**示例输出：**

```
[前置检查]
  ✓ Node.js v22.23.1
  ✓ npm registry → https://registry.npmmirror.com
  ✓ GitHub proxy → ghproxy.net
  ✓ apt mirror → mirrors.tuna.tsinghua.edu.cn

[Phase 1] 配置补全
  ✓ searxng/settings.yml (secret_key 已生成)
  ✓ agent/package.json (已存在)
  ✓ agent/bin/ (已存在)

[Phase 2-A] npm 依赖（统一根）
  ✓ agent/node_modules/ (~50 packages，10 扩展共享)

[Phase 2-B] Python 环境
  ✓ searxng/venv/ (Python 3.12.3)
  ✓ searxng/repo/ (HEAD at a1b2c3d)

[Phase 2-C] 二进制下载
  ✓ agent/bin/fd (v9.0.0)
  ✓ agent/bin/rg (v14.1.0)


[验证]
  ✓ YAML 校验通过
  ✓ JSON 校验通过

重建完成 (总耗时: 45s)
```

执行期间每 60s 向用户输出的进度行示例：

```
[重建进度 +3m12s] Phase 1/2 完成 ✓；当前：Phase 2-B searxng venv pip install（预估 5-15 分钟）；已完成 6/13 项
[重建进度 +5m40s] 日志 40s 无新输出，进程存活、pip 下载中（包大小持续增长）——正常，继续等待
```

---

## `pi-backup verify`

体检 `~/.pi/` 的备份/同步健康状态：git 仓库卫生、密钥泄漏风险、扩展可加载性。**同步前、重建后、跨机迁移前各跑一次。**

**执行步骤：**

1. 检查 `~/.pi/.gitignore` 存在，且包含 `agent/auth.json`、`agent/settings.json`、`agent/models.json`、`agent/models-store.json`、`agent/pi-voice.json`、`searxng/settings.yml` 排除规则（缺失即报错：rsync/手工拷贝同步时最易丢失，会导致密钥被提交）。
2. 运行 `git ls-files`，检查上述敏感文件未被追踪——任一命中**报错**并提示 `git rm --cached <file> && git commit -m "remove secret"`。
3. 检查 `~/.pi/.git` 存在且 `git remote -v` 已配置（未配置则提示 `git remote add origin <url>`）。
4. 检查 `PI_DIST` 可解析：`echo $PI_DIST` 非空，或 `ls ~/.local/share/pi-node/*/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 存在（缺失时 pi-voice 加载失败，见注意事项 13）。
5. 配置变更检测（同 sync 前置检查 5/6）：gitignored 配置基线对比 + 外部配置副本差异——有变化则提示（非阻塞，需确认是否有意修改）。
6. 冒烟测试（可选 `--smoke`）：`timeout 90 pi -p "回复 OK"`——输出 `OK` 且 exit 0 即扩展全部加载成功。
6. 输出体检报告，每项 ✓/✗。

**示例输出：**

```
pi-backup verify
  ✓ .gitignore 存在且排除规则齐备
  ✓ 敏感文件未被 git 追踪（auth/settings/models/pi-voice/searxng）
  ✓ git remote: origin → https://github.com/cyfxxx/pi-tools.git
  ✓ PI_DIST 可解析
  ✓ 冒烟测试: pi -p 输出 OK（10 扩展全部加载）
体检通过
```

---

## `pi-backup list`

列出可用备份或检查 git 仓库状态。

**参数：**

| 参数 | 说明 |
|------|------|
| `--backup <path>` | 指定备份文件路径（默认扫描备份目录下 `pi-backup-*.tar.gz`） |
| `--remote` | 显示 git 远程仓库信息和最新 commit |

**执行步骤（默认）：**

1. 运行 `ls -lh {备份目录}/pi-backup-*.tar.gz 2>/dev/null`（Termux: `/storage/emulated/0/我的文件/pi-backup/`；其他: `~/pi-backups/`）列出所有本地备份。
2. 如果无备份，提示用户尚未创建过备份。
3. 每个备份文件显示：文件名、大小、修改时间。

**执行步骤（`--remote`）：**

1. 运行 `cd ~/.pi && git remote -v` 显示 remote。
2. 运行 `git log --oneline -3` 显示最近 3 个 commit。
3. 运行 `git status --short` 显示是否有未提交变更。

**示例输出：**

```
本地备份（备份目录）：
  pi-backup-myhost-20260701_120000.tar.gz  1.4 MB  (7月1日 12:00)
  pi-backup-myhost-20260616_083000.tar.gz  1.2 MB  (6月16日 08:30)

远程仓库：
  origin  https://github.com/cyfxxx/pi-tools.git (fetch)
  origin  https://github.com/cyfxxx/pi-tools.git (push)

最近提交：
  9c1f6e5 docs: 添加项目说明 README.md
  d4f81a5 sync: 配置清理与扩展扁平化

工作区状态：干净（无未提交变更）
```

---

## 备份清单

> 完整三表（始终包含 / 默认排除（`--full` 时额外包含） / 按需包含）见 `references/BACKUP-MANIFEST.md`。
> create/restore/clone 执行前先读该文件确认覆盖范围与重建方式。

## 注意事项

1. **敏感数据**：`auth.json` 包含 API 密钥，默认不包含在备份中。`git sync` 时 `.gitignore` 会自动排除它——但仍建议定期确认 `git ls-files agent/auth.json` 为空，防止意外追踪。
2. **重启生效**：恢复或克隆后必须重启 pi 才能加载更新后的配置。
3. **恢复前快照**：每次 `restore` 操作会自动创建 `~/.pi/pre-restore-{timestamp}.tar.gz`，可用于回滚。
4. **跨机器恢复**：`settings.yml` 中的 SearXNG secret_key 是安装时生成的。跨机器恢复后需要重新生成。
5. **重建超时**：`npm install` 在网络慢时可能超时。建议在网络稳定的环境下执行 `rebuild`。
6. **crontab 不包含在归档中**：使用 `crontab -l > pi-crontab.bak` 单独备份调度条目。恢复后运行 `bash scripts/install-cron.sh` 重建。
7. **调度任务文件**：`agent/scheduled-tasks.json` 已在备份清单中。如果恢复时该文件存在但扩展尚未安装，运行 `bash scripts/rebuild.sh --yes` 补装扩展依赖和 crontab。
8. **wrapper 恢复**：如果备份中包含了 pi-autopilot 扩展和 wrapper 脚本，恢复后建议运行 `~/.pi/scripts/install-wrapper.sh` 重新安装 wrapper，以启用自动重启能力。如果不需要自动重启，跳过此步骤即可。
9. **tmux 依赖**：pi-tmux 扩展与 pi 自身 TUI 依赖 tmux。恢复后 rebuild Phase 2-F2 自动同步 tmux 配置（tmux 命令本身不随 rebuild 自动安装，缺失时按系统包管理器手动安装）。若 tmux 缺失，pi-tmux 工具会返回安装指引错误。跨机器恢复注意系统差异（macOS 用 brew 且 `xclip` 绑定需改 `pbcopy`），见 `docs/alacritty-tmux-setup.md`。
10. **tmux 会话重连**：pi-wrapper.sh 支持 `PI_TMUX_SESSION=<名>` 环境变量把 pi 放进指定 tmux 会话（仅交互式生效），配合 tmux-resurrect 可持久恢复。设置该变量时确保不写入 `/etc/profile` 等全局位置，避免影响 pi-autopilot 子进程。
11. **多机 memory 冲突（P1）**：`memory/entries.json` 入库共享（已带环境标签，pi-memory 注入/检索自动过滤）；`notes.json`/`summaries.json` 已 git 忽略（会话级/环境特定，不入库）。多机交替 push/pull 时 entries.json 冲突处理：`git checkout --theirs memory/entries.json` 保留远程 → 本地重要新增从 stash/备份手工合并（pi-memory 会自动重新提取会话，一般无需手工）。详见 `docs/ENVIRONMENTS.md`。
12. **配置类文件跨机边界**：`settings.json`（主配置）、`models.json`（模型/密钥，pi ≥0.84 为 `models-store.json`）、`pi-voice.json`（whisper 令牌）均不在 git 同步范围内且默认不进归档。跨机迁移三选一：① `pi-backup create --with-auth` 打包 → restore；② scp 直接传；③ 新设备手动重建。`rebuild` 的验证阶段会探测缺失并给出对应指引（注意：旧脚本探测的是 `models.json`，pi ≥0.84 实际使用 `models-store.json`，以 `pi -p` 冒烟测试为准）。
12. **tsconfig 路径重写**：`rebuild` Phase 2-D 生成/重写**本机专属** `agent/extensions/tsconfig.local.json`（extends 共享 `tsconfig.json` + 本机 pi 安装根 paths；共享配置不含 paths，多环境不互相污染）。手动 `pi update` 换版本后再次运行 `rebuild.sh` 即可同步。
13. **PI_DIST（wrapper 后的 dist 定位）**：wrapper 接管 `pi` 命令后，补丁脚本（patch-*.mjs）与 pi-voice 的 dist 探测会解析到 wrapper 自身而失败——wrapper 已自动导出 `PI_DIST`（由解析出的 cli.js 推导）。直启 `pi-original` / node cli.js 时需手动：`export PI_DIST="$(dirname "$(readlink -f "$(which pi-original)")")"`。缺失时 pi-voice 加载报 `Extension runtime not initialized`，pi 完全无法启动（本次重建实测）。
14. **端到端冒烟测试**：重建/恢复后必须跑 `timeout 90 pi -p "回复 OK"`——它验证扩展加载（最易出错的一环）与模型链路，比单项检查更能暴露 wrapper/PI_DIST/扩展兼容问题。
15. **`pi-backup verify`**：同步前先跑体检（git 卫生/密钥泄漏/`.gitignore` 完整性），防止 `rsync` 式同步丢了 `.gitignore` 后把密钥提交进仓库（本次重建曾遇到，靠事后 `git rm --cached` 才救回）。


---

## 使用后改进（必做）

任务收尾时清点：执行过程与本文步骤/路径/结论的偏差。有 → 追加一条到 `improvements.md`（证据导向：命令、路径、现象，不直接改正文）。未合并条目 ≥3 条或用户要求时，合并进正文并清日志。机制全文见 `agent/skills/SKILLS-MAINTENANCE.md`。

