---
name: pi-backup
description: 备份和恢复 pi agent 配置、技能、扩展源码和用户数据。支持本地 tar.gz 归档和 GitHub git 同步两种模式。用户说"备份""存档""迁移""恢复""同步""推送"时触发。
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
- [`pi-backup list`](#pi-backup-list) — 列出可用备份 / 检查状态

---

## `pi-backup create`

创建本地 tar.gz 归档备份。

**参数：**

| 参数 | 说明 |
|------|------|
| `--output <path>` | 输出路径（默认 `~/pi-backups/pi-backup-{hostname}-{timestamp}.tar.gz`） |
| `--with-auth` | 包含 `auth.json`（API 密钥）。默认不包含。 |
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
     "excluded": ["agent/npm/node_modules/", "..."]
   }
   ```
5. 运行 `tar czf {output_path} -C /tmp/pi-backup-{timestamp}/ .`
6. 清理临时目录：`rm -rf /tmp/pi-backup-{timestamp}/`
7. 验证完整性：`tar tzf {output_path} | head -5` 检查可读。
8. 执行保留轮转：如果 `~/pi-backups/` 下同模式备份超过 `--keep N` 份，删除最旧的。
9. 报告备份文件路径、大小、文件数量。

**示例输出：**

```
备份完成：~/pi-backups/pi-backup-myhost-20260701_120000.tar.gz (1.4 MB)
包含 52 个文件（默认模式，不含 auth）
保留 5 份，已清理 0 份旧备份
```

---

## `pi-backup sync`

将当前 `~/.pi/` 的所有修改通过 git commit + push 同步到 GitHub。

**参数：**

| 参数 | 说明 |
|------|------|
| `--message "msg"` | 自定义 commit 信息（默认 `pi-backup: {ISO-8601}`） |
| `--remote <name>` | 远程仓库名（默认 `origin`） |
| `--branch <name>` | 分支名（默认 `master`） |

**前置检查（优先执行，任一不通过则中止并报错）：**

1. 检查 `~/.pi/.git` 目录存在 → 否则报错 `~/.pi/ 不是 git 仓库`
2. 检查 `git remote` 已配置 → 否则报错 `未配置远程仓库，请先运行 git remote add`
3. 运行 `git remote -v` 检查 remote URL 可到达 → 否则报错 `远程仓库不可达`
4. 运行 `git status --porcelain` 检查是否有变更 → 若无变更则提示 `无变更需要同步`
5. 检查 `agent/auth.json` 是否被意外追踪：运行 `git ls-files agent/auth.json | grep auth.json`，如果返回非空，**立即报错中止**并提示 `auth.json 已被 git 追踪！请立即从仓库中移除！`

**执行步骤：**

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

1. 如果未指定 `--backup`，列出 `~/pi-backups/pi-backup-*.tar.gz` 并按时间排序，让用户选择。
2. 检查备份文件完整性：`tar tzf {backup_path} | head -1`，若失败则报错。
3. 显示差异摘要——列出备份中包含的目录和当前 `~/.pi/` 的差异概要。
4. 确认用户确要恢复。

**阶段 2：快照**

5. 创建恢复前快照：
   ```
   SNAPSHOT_PATH="~/.pi/pre-restore-{timestamp}.tar.gz"
   tar czf "$SNAPSHOT_PATH" \
     -C ~ .pi/agent/settings.json .pi/agent/AGENTS.md .pi/agent/APPEND_SYSTEM.md \
        .pi/agent/trust.json .pi/agent/skills .pi/agent/extensions .pi/agent/npm/package.json \
         .pi/ctx-lite .pi/searxng/settings.yml
   ```

**阶段 3：解压**

6. 解压归档：`tar xzf {backup_path} -C ~/`
7. 验证关键文件：`ls -la ~/.pi/agent/settings.json` 等。
8. 如果备份中不含 `auth.json` 且未指定 `--include-auth`：告知用户 `auth.json` 未被恢复，当前文件保持不变。

**阶段 4：重建依赖**

9. 除非指定了 `--no-rebuild`，否则运行[重建流程](#pi-backup-rebuild)（`--yes` 时自动全部执行，否则逐项确认）。

**阶段 5：报告**

10. 打印恢复摘要：

```
恢复完成
  来源：~/pi-backups/pi-backup-myhost-20260701_120000.tar.gz
  文件：已解压 52 个
   重建：npm 依赖 ✓ | 扩展依赖 ✓ | fd/rg ✓ | SearXNG venv ✓
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
3. 验证 `~/.pi/agent/settings.json` 存在。
4. 运行[重建流程](#pi-backup-rebuild)（`--yes` 时自动全部执行，否则逐项确认）。
5. 告知用户重启 pi。

---

## `pi-backup rebuild`

重建所有被 git 排除的可重建内容。适用于恢复后、新克隆后、或依赖被误删后。

**参数：**

| 参数 | 说明 |
|------|------|
| `--yes` | 非交互式，自动重建全部项 |
| `--china` | 启用中国镜像加速（apt/npm/GitHub），默认自动检测 |

**前置检查（在重建前执行一次）：**

| 检查项 | 条件 | 操作 |
|--------|------|------|
| Node.js 版本 | `< 20` | 使用 NodeSource 安装 Node.js 22.x |
| pip 镜像 | `--china` 或网络不可达 | `pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple` |
| npm 镜像 | `--china` 或网络不可达 | `npm config set registry https://registry.npmmirror.com` |
| GitHub 镜像 | `--china` 或网络不可达 | 所有 `github.com` 下载通过 `ghproxy.net` 代理 |
| apt 镜像 | `--china` 或网络不可达 | 替换 `/etc/apt/sources.list.d/ubuntu.sources` URIs 为清华源 |

**重建清单（并发组间顺序执行，组内并行）：**

**Phase 1 — 配置补全（顺序）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 0 | `searxng/settings.yml` | 文件不存在或缺少 `secret_key` | `cd ~/.pi/searxng && bash generate-config.sh 2>&1` |
| 1 | `agent/npm/package.json` | 文件不存在且 `settings.json` 引用了 `packages` | 自动生成最小 `package.json`（含 `settings.json` 中 `packages` 字段列出的依赖） |
| 2 | `~/.pi/agent/bin/` | 目录不存在 | `mkdir -p ~/.pi/agent/bin` |

**Phase 2 — 并行组 A（npm 依赖）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 3 | `agent/npm/node_modules/` | 存在 `agent/npm/package.json` 且目录不存在或为空 | `cd ~/.pi/agent/npm && npm install 2>&1` |
| 4 | `agent/extensions/*/node_modules/` | 扩展目录下有 `package.json` 且缺 `node_modules` | 对每个匹配扩展：`cd ~/.pi/agent/extensions/{name} && npm install 2>&1` |

**Phase 2 — 并行组 B（Python 环境）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 5 | `searxng/venv/` | `searxng/settings.yml` 存在且 `searxng/venv/bin/python` 不存在 | `cd ~/.pi/searxng && python3 -m venv venv && venv/bin/pip install searxng granian 2>&1` |
| 6 | `searxng/repo/` | `searxng/repo/` 不存在或为空 | `git clone --depth 1 https://github.com/searxng/searxng ~/.pi/searxng/repo 2>&1`（中国网络通过镜像代理） |

**Phase 2 — 并行组 C（二进制下载，并发执行）：**

| # | 重建项 | 条件 | 命令 |
|---|--------|------|------|
| 7 | `agent/bin/fd` | `fd` 命令不可用 | `apt-get install -y fd-find 2>&1` 并软链到 `~/.pi/agent/bin/fd` |
| 8 | `agent/bin/rg` | `rg` 命令不可用 | `apt-get install -y ripgrep 2>&1` 并软链到 `~/.pi/agent/bin/rg` |


**不重建的项（始终跳过）：**

- `agent/sessions/` — 对话历史无法重建，如需保留应使用 `--include-sessions` 参数恢复
- `agent/auth.json` — API 密钥无法自动重建，需用户手动创建或从备份恢复

**验证步骤（每项重建后执行）：**

| 验证项 | 命令 |
|--------|------|
| npm 依赖 | `ls ~/.pi/agent/npm/node_modules/ 2>/dev/null \| wc -l` |
| 扩展依赖 | `for d in ~/.pi/agent/extensions/*/; do [ -d "$d/node_modules" ] && echo "$d OK" \|\| echo "$d MISSING"; done` |
| fd | `fd --version 2>/dev/null \|\| echo "fd not available"` |
| rg | `rg --version 2>/dev/null \|\| echo "rg not available"` |
| SearXNG venv | `~/.pi/searxng/venv/bin/python --version 2>/dev/null \|\| echo "venv not found"` |
| SearXNG repo | `[ -d ~/.pi/searxng/repo/.git ] && echo "OK" \|\| echo "MISSING"` |

| settings.yml | `python3 -c "import yaml; yaml.safe_load(open('$HOME/.pi/searxng/settings.yml'))" 2>/dev/null \|\| echo "YAML 校验失败"` |
| settings.json | `python3 -c "import json; json.load(open('$HOME/.pi/agent/settings.json'))" 2>/dev/null \|\| echo "JSON 校验失败"` |

**示例输出：**

```
[前置检查]
  ✓ Node.js v22.23.1
  ✓ npm registry → https://registry.npmmirror.com
  ✓ GitHub proxy → ghproxy.net
  ✓ apt mirror → mirrors.tuna.tsinghua.edu.cn

[Phase 1] 配置补全
  ✓ searxng/settings.yml (secret_key 已生成)
  ✓ agent/npm/package.json (已存在)
  ✓ agent/bin/ (已存在)

[Phase 2-A] npm 依赖
  ✓ agent/npm/node_modules/ (54 packages)
  ✓ agent/extensions/pi-web-toolkit/node_modules/ (49 packages)

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

---

## `pi-backup list`

列出可用备份或检查 git 仓库状态。

**参数：**

| 参数 | 说明 |
|------|------|
| `--backup <path>` | 指定备份文件路径（默认扫描 `~/pi-backups/pi-backup-*.tar.gz`） |
| `--remote` | 显示 git 远程仓库信息和最新 commit |

**执行步骤（默认）：**

1. 运行 `ls -lh ~/pi-backups/pi-backup-*.tar.gz 2>/dev/null` 列出所有本地备份。
2. 如果无备份，提示用户尚未创建过备份。
3. 每个备份文件显示：文件名、大小、修改时间。

**执行步骤（`--remote`）：**

1. 运行 `cd ~/.pi && git remote -v` 显示 remote。
2. 运行 `git log --oneline -3` 显示最近 3 个 commit。
3. 运行 `git status --short` 显示是否有未提交变更。

**示例输出：**

```
本地备份（~/pi-backups/）：
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

### 始终包含（默认模式）

| 分组 | 相对路径 | 说明 |
|------|----------|------|
| 核心配置 | `agent/settings.json` | 主配置：provider、model、extension 设置 |
| 核心配置 | `agent/trust.json` | 项目信任设置 |
| 核心配置 | `agent/AGENTS.md` | agent 描述文件 |
| 核心配置 | `agent/APPEND_SYSTEM.md` | 追加系统提示词 |
| 技能 | `agent/skills/*/` | 所有已安装技能（SKILL.md 及附属文件） |
| 扩展源码 | `agent/extensions/*/` | 扩展源码，排除 `node_modules/`、`dist/`、`.git/` |
| npm 配置 | `agent/npm/package.json` | npm 包声明 |
| 仓库配置 | `.gitignore` | git 忽略规则 |
| 仓库文档 | `README.md` | 说明文档 |
| ctx-lite | `ctx-lite/` | 上下文笔记和检查点（如存在） |
| 记忆 | `memory/` | pi-memory 持久记忆数据（如存在） |
| SearXNG 配置 | `searxng/settings.yml` | SearXNG 配置文件（含 secret_key） |
| SearXNG 脚本 | `searxng/start.sh`、`searxng/stop.sh` | 启停脚本 |
| 调度任务 | `agent/scheduled-tasks.json` | 定时任务定义（扩展与 cron 共享） |
| 调度脚本 | `scripts/pi-cron.sh` | cron 包装脚本（离线执行） |
| 调度安装脚本 | `scripts/install-cron.sh`、`scripts/install-systemd.sh` | crontab / systemd 安装 |


### 默认排除（`--full` 时额外包含）

| 分组 | 相对路径 | 说明 | 重建方式 |
|------|----------|------|---------|
| 会话 | `agent/sessions/` | 对话历史（可能含隐私） | 不可重建，需通过 `--include-sessions` 恢复 |
| npm 依赖 | `agent/npm/node_modules/` | npm 包 | `npm install` |
| 扩展依赖 | `agent/extensions/*/node_modules/` | 扩展 npm 包 | 每个扩展目录下 `npm install` |
| 运行时二进制 | `agent/bin/` | fd、rg | 自动下载 |
| Python 虚拟环境 | `searxng/venv/` | SearXNG Python 依赖 | `python3 -m venv venv && pip install` |
| SearXNG 源码 | `searxng/repo/` | SearXNG 原始项目 | `git clone` |
| 日志 | `searxng/searxng.log` | 运行时日志 | 不可重建，不恢复 |
| 调度日志 | `logs/scheduler/` | 离线执行日志 | 不可重建，不恢复 |
| npm lock | `agent/npm/package-lock.json` | npm 锁定文件 | 由 `npm install` 生成 |
| 扩展 lock | `agent/extensions/*/package-lock.json` | 扩展 npm 锁定文件 | 由 `npm install` 生成 |
| 运行时缓存 | `context-mode/` | 上下文模式缓存 | 不可重建，不恢复 |
| 计划文件 | `plans/` | pi 自动生成的计划 | 不可重建，不恢复 |

### 按需包含

| 分组 | 相对路径 | 说明 |
|------|----------|------|
| auth | `agent/auth.json` | API 密钥。**默认不包含**，需 `--with-auth` 确认。包含后应提醒用户注意安全。 |

---

## 注意事项

1. **敏感数据**：`auth.json` 包含 API 密钥，默认不包含在备份中。`git sync` 时 `.gitignore` 会自动排除它——但仍建议定期确认 `git ls-files agent/auth.json` 为空，防止意外追踪。
2. **重启生效**：恢复或克隆后必须重启 pi 才能加载更新后的配置。
3. **恢复前快照**：每次 `restore` 操作会自动创建 `~/.pi/pre-restore-{timestamp}.tar.gz`，可用于回滚。
4. **跨机器恢复**：`settings.yml` 中的 SearXNG secret_key 是安装时生成的。跨机器恢复后需要重新生成。
5. **重建超时**：`npm install` 在网络慢时可能超时。建议在网络稳定的环境下执行 `rebuild`。
6. **crontab 不包含在归档中**：使用 `crontab -l > pi-crontab.bak` 单独备份调度条目。恢复后运行 `bash scripts/install-cron.sh` 重建。
7. **调度任务文件**：`agent/scheduled-tasks.json` 已在备份清单中。如果恢复时该文件存在但扩展尚未安装，运行 `bash scripts/rebuild.sh --yes` 补装扩展依赖和 crontab。

