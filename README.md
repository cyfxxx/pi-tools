# pi-tools

[Pi Coding Agent](https://pi.dev/) 个人配置文件仓库。

## 结构

```
├── agent/
│   ├── settings.json          Pi 主配置（provider, model, extensions, skills）
│   ├── AGENTS.md              项目环境描述
│   ├── APPEND_SYSTEM.md       追加系统提示词
│   ├── lib/                   共享库模块
│   │   ├── token-budget.ts    跨扩展 Token 用量追踪（兼容层 → context-budget.ts）
│   │   ├── note-store.ts      ctx-lite 笔记持久化（已并入 pi-memory，保留兼容）
│   │   ├── prune.ts           工具输出裁剪（兼容层 → context-budget.ts）
│   │   ├── context-budget.ts  统一 Token 预算/估算/裁剪 + 缓存命中统计
│   │   ├── usage-diag.ts      用量诊断（/usage-diag 数据源）
│   │   ├── auto-compact.ts    自动压缩触发策略
│   │   ├── TOKEN-BUDGET.md    使用文档
│   │   └── tests/             单元测试
│   ├── extensions/            自定义扩展
│   │   ├── pi-web-search/     网络搜索（SearXNG 私密搜索 + Bing 备选 + HTTP 抓取）
│   │   ├── pi-autopilot/      自主运行（定时任务 + 自管理 + 失败自愈：failover/看门狗/遥测/预算）
│   │   ├── pi-browser/       浏览器自动化（CloakBrowser，自 pi-web-toolkit 拆出）
│   │   ├── plan-mode/         计划模式（TUI 计划/任务管理）
│   │   ├── pi-memory/         跨会话持久记忆（已合并 ctx-lite，自主学习闭环）
│   │   ├── subagent/          子代理（delegate 给专门 agent）
│   │   ├── pi-tmux/           tmux 会话管理（后台任务/长任务）
│   │   ├── pi-voice/          语音交流（Termux：录音转写 + TTS 朗读）
│   │   ├── pi-link/           多设备互联（ssh 通道 + 远程 pi RPC，link_send/link_status）
│   │   └── pi-context/        token 优化中枢（已融合 pi-router：路由策略注入 + thinking 剪枝/compaction 去重/输出截断 + 缓存统计）
│   ├── agents/                agent 定义（子代理模板）
│   │   ├── scout.md              快速代码探测，返回压缩上下文
│   │   ├── worker.md             通用执行 agent
│   │   └── reviewer.md           代码审查
│   ├── prompts/               pi 全局 prompt templates（*.md 注册为 /name 斜杠命令）
│   ├── skills/                自定义技能
│   │   ├── pi-translate-zh/   中文翻译
│   │   ├── pi-backup/         备份恢复技能（本地归档 + GitHub 同步）
│   │   └── pi-code-review/    代码审查（确定性检查 + 分级报告）
│   └── npm/
│       ├── package.json       npm 包声明（rebuild.sh 按 settings.json packages 自动生成）
│       └── .gitignore         只排除 node_modules/ 和 package-lock.json
├── docs/                      开发与部署文档
│   ├── TERMUX-DEV-NOTES.md    Termux 环境开发注意事项（Android API/录音/网络）
│   ├── PI-EXT-DEV-NOTES.md    Pi 扩展开发注意事项（隐性契约/踩坑/黑盒流程）
│   ├── PI-SDK-EXTENSION.md    Pi SDK 扩展开发说明
│   └── alacritty-tmux-setup.md  tmux 部署（WSL2/WSLg、GPU、clipboard）
├── deploy/                    部署配置（systemd unit 模板 / tmux 配置与状态脚本 / pi-link 公钥合集）
├── memory/                    pi-memory 运行时数据（entries/notes/summaries/checkpoints）
├── searxng/                   SearXNG 自托管搜索引擎
│   ├── settings.yml           SearXNG 配置（含 secret_key）
│   ├── generate-config.sh     settings.yml 自动生成脚本
│   ├── start.sh               启动脚本
│   └── stop.sh                停止脚本
├── scripts/
│   ├── rebuild.sh             一键重建脚本（幂等、并行下载、国内镜像加速）
│   ├── pi-cron.sh             pi-autopilot 离线执行包装脚本
│   ├── install-cron.sh        安装 crontab 条目
│   ├── install-systemd.sh     安装 systemd timer（备选）
│   ├── pi-wrapper.sh          进程外生命周期管理器（自动重启）
│   ├── install-wrapper.sh     wrapper 安装/卸载
│   ├── pi-orig.sh             绕过 wrapper 直启（故障逃生）
│   ├── test-all.sh            一键全量回归（测试+类型+冲突检查）
│   ├── pi-whisper.sh          whisper 常驻服务管理（start/stop/status/restart）
│   ├── whisper-server.py      faster-whisper HTTP 服务（127.0.0.1:18766）
│   ├── patch-*.mjs            核心补丁（voice-enter 回车拦截 / footer-live-context / plan-tools，rebuild.sh 自动执行）
│   └── pi-bg.sh               后台任务四件套隔离（见 README-pi-bg.md）
├── portable/                  便携 pi（Windows 原生）种子：构建脚本 + 模板
│   ├── bin/                  管理脚本（setup 构建器 / verify 验证 / diag 诊断 / update-pi 升级 / update-portable 扩展同步 / sync git）
│   ├── start.bat/start.ps1   入口启动器（显式 node + PI_CODING_AGENT_DIR + junction 透明）
│   ├── ca-bundle.crt         证书包（GitHub 被墙环境的 git 用）
│   ├── tools/tmux/           tmux shim（wsl.exe tmux %*）
│   └── README.md             种子/实例布局、构建、会话恢复、升级说明
├── logs/
│   └── scheduler/             离线执行日志（自动清理，不 git 跟踪）
├── .gitignore                 已排除大二进制、密钥、运行时产物
└── README.md                  本文件
```

## 备份与恢复

`pi-backup` 技能提供两套备份模式：

### 本地归档

```bash
pi-backup create                 # 默认备份（不含密钥、依赖等可重建内容）
pi-backup create --full          # 全量备份（含 sessions、node_modules 等）
pi-backup create --with-auth     # 包含 auth.json
pi-backup list                   # 列出所有本地备份
pi-backup restore --backup <path>  # 从归档恢复 + 自动重建依赖
```

### GitHub 同步

```bash
pi-backup sync                   # git commit + push 到 origin
pi-backup clone                  # 从 remote 拉取最新 + 自动重建依赖
pi-backup clone --repo <url>     # 从指定仓库克隆到 ~/.pi/
pi-backup list --remote          # 查看 remote 和最近提交
pi-backup verify                 # 体检：git 卫生 / 密钥泄漏 / 冒烟测试
```

> **重建前先备份**：执行 `rebuild.sh` 或跨机迁移前，先 `pi-backup create`（或 `pi-backup sync`）留存当前状态；重建后运行 `pi-backup verify` 体检（git 卫生、密钥泄漏、`.gitignore` 完整性、扩展可加载性）。

### 依赖重建

两种方式：

**方式一（推荐）：`scripts/rebuild.sh`**

```bash
./scripts/rebuild.sh             # 交互式重建
./scripts/rebuild.sh --yes       # 静默自动重建
```

**方式二：pi-backup skill**

```bash
pi-backup rebuild                # 重建全部被排除的可重建内容
pi-backup rebuild --yes          # 静默自动重建
```

**rebuild.sh 特性：**

- **幂等** — 已存在项跳过，只重建缺失内容（npm 按 package.json 逐包探测缺失，非仅目录非空；venv 要求 python+pip 齐备）
- **国内镜像加速** — 自动检测并切换 apt/npm/pip/GitHub 镜像（探测 baidu.com，成功后 GitHub 走 ghproxy.net 前缀）
- **Node.js 自动升级** — 检测到 <20 时自动安装 22.x
- **并行执行** — npm 依赖（≤3 并发滚动窗口）、venv、SearXNG repo 三路并行；SearXNG 依赖与 npm 重叠执行（npm 是耗时大头）
- **浏览器自动安装** — pi-browser 扩展存在时自动安装 CloakBrowser Chromium；直连失败自动回退 GH_PROXY 镜像源（CLOAKBROWSER_DOWNLOAD_URL），仍失败给出手动 TLS 绕过命令；Chromium 运行库按 .so 缺失自动补装（libasound2t64 等，t64/经典包名双回退）
- **自动补全配置** — 自动生成 `searxng/settings.yml`、`agent/npm/package.json`（如缺失）；SearXNG 就绪后自动把 `pi-web-search` 指向本地实例（127.0.0.1:8889）
- **格式校验** — 重建后自动验证 YAML/JSON 配置文件（模型配置兼容 `models.json`/`models-store.json`）
- **venv 实际探测** — 安装依赖前用 `python3 -m venv /tmp/.venv-probe` 验证 ensurepip 可用（dpkg 里的 `python3-venv` 可能是空壳），失败自动补装 `python3.12-venv`
- **TUI 补丁自动定位 dist** — 补丁脚本不再依赖 `which pi`（wrapper 接管后反推会失败），rebuild.sh 自行推导 pi 安装目录并传入
- **日志与退出码** — `--yes` 模式自动落盘 `logs/rebuild-<ts>.log`，各阶段标注耗时（+Ns）；verify 有异常时退出码非 0（自动化可判定失败，`--no-log` 关闭落盘）

支持自动下载/重建：npm 依赖、扩展依赖、fd/rg 二进制、SearXNG venv、SearXNG 源码（从 repo `requirements.txt` 安装全部依赖）。

### Windows 原生便携安装（pi-portable）

不想在 Windows 主机上安装、又想原生运行 pi（带完整配置与会话）时，使用便携包：

1. 新建空文件夹，放入 `portable/` 下全部脚本；从本机拷贝 `~/.pi` → 包内 `.pi/`（agent 扩展/配置、sessions 会话、memory 记忆）
2. PowerShell 运行 `setup.ps1`（自动：下载 Node LTS 24+ → npmmirror 镜像装 pi → 生成启动器）
3. `verify.ps1` 验证环境 → `start.bat --continue` 恢复 WSL 会话

关键机制（详见 `portable/README.md` 与记忆「便携 pi Windows 构建全套经验」）：

- **USERPROFILE=包根** + **PI_CODING_AGENT_DIR 显式**——pi 的配置/扩展/会话全落包内 `.pi/`
- **显式 `node.exe` 调 cli.js**——绕开 npm shim 的 node 解析（会落到系统 node，v22.14 无 zstd 导致 deepseek zstd 响应崩溃）
- **Node 必须 24+**——22.x 的 zlib 无 `createZstdDecompress`
- **固定 cwd=包根**——pi 会话目录按 cwd 编码（`sessions/--<路径>--/`），启动器固定 cwd 后 `--continue` 稳定恢复；构建时预置 WSL 会话快照
- **pi-voice Windows 原生支持**（71209d3：ffmpeg dshow 录音 + SAPI 朗读）；settings 排除受 projectTrusted 限制
- **fd/rg Windows exe 预置** `.pi/agent/bin/`（GitHub 下载被墙）

已知限制：searxng/whisper 为 Python 服务不在包内（搜索/语音需目标机另装）；包内 `.pi/` 含密钥自行决定是否携带。

### 新设备恢复引导

```bash
git clone https://github.com/cyfxxx/pi-tools.git ~/.pi
cd ~/.pi && bash scripts/rebuild.sh --yes
bash scripts/install-wrapper.sh   # 可选：安装自动重启 wrapper
```

> **`~/.pi/` 已存在时**：`git clone` 到非空目录会失败；不要直接 `rm -rf ~/.pi`（会删掉本地会话/配置/凭据且无法恢复）。建议先 `mv ~/.pi ~/.pi.bak` 再克隆，确认无误后删除备份。
>
> **恢复本地配置**：clone 后按上方「git 模式边界」表恢复缺失文件。推荐用 pi-backup（原机 `pi-backup create --with-auth` → 新机 `pi-backup restore`），比手动 `cp` 可复现且有体检。

> **git clone 报证书验证失败（CAfile: none）**：部分网络环境（企业代理/沙箱/镜像）拦截 TLS，系统 CA 无法验证 GitHub 证书链。此时：
> ```bash
> git config --global http.sslVerify false   # 或单次: git -c http.sslVerify=false clone ...
> ```
> 也可先 `apt-get install -y ca-certificates && update-ca-certificates` 尝试修复系统证书。

> **git push 凭证（SSH over 443）**：本仓库 remote 已切换为 `ssh://git@ssh.github.com:443/cyfxxx/pi-tools.git`——SSH key（`~/.ssh/id_ed25519`）认证，**免 PAT 免代理**（github.com:443 被 GFW 封锁，v2ray 代理会挂）。新环境：生成密钥 → GitHub Settings → SSH keys 添加 → `git remote set-url origin ssh://git@ssh.github.com:443/cyfxxx/pi-tools.git`。不要改回 HTTPS 或带 token 的 URL。

> **wrapper 与 PI_DIST**：`install-wrapper.sh` 接管 `pi` 命令后，扩展（pi-voice）与补丁脚本（patch-*.mjs）通过 `PI_DIST` 环境变量定位 pi dist 目录（wrapper 已自动导出，`echo $PI_DIST` 验证）。直启 `pi-original` 时需手动导出，否则 pi 启动报 `Extension runtime not initialized`（见常见问题）。

**前置条件：**

| 检查项 | 要求 | 验证命令 |
|--------|------|---------|
| Node.js | >= 20 | `node -v` |
| npm | 随 Node 自带 | `npm -v` |
| python3 + venv | >= 3.10 | `python3 -m venv /tmp/.venv-probe && rm -rf /tmp/.venv-probe && echo ok`（必须实际创建成功；Debian/Ubuntu 需装 `python3.12-venv`，`dpkg` 里的 `python3-venv` 可能是空壳） |
| git | 任意版本 | `git --version` |
| ca-certificates | 已安装（脚本会自动补装） | `dpkg -l ca-certificates` |
| 磁盘空间 | >= 2GB 可用 | `df -h .` |

**git 模式边界（缺失项，需手动提供）：** git 同步**不含**以下文件（`.gitignore` 排除），新设备 clone 后缺失是正常的，按表补救，否则 pi 无法启动或功能不完整：

| 缺失项 | 后果 | 补救 |
|--------|------|------|
| `agent/settings.json` + `models.json`（pi ≥0.84 为 `models-store.json`） | pi 无模型配置，无法启动对话 | 原机 `scp` 拷贝，或原机 `pi-backup create --with-auth` 后新机 `pi-backup restore` |
| `agent/auth.json` | 无 API 凭据 | 同上（`--with-auth` 归档） |
| `agent/pi-voice.json` | 语音扩展/whisper token 不一致 | 原机拷贝（语音功能不使用可跳过） |
| `~/.tmux.conf`、`~/.termux/` | tmux 无 `extended-keys`，语音快捷键失效 | **`rebuild.sh` 已自动同步**（Phase 2-F2：diff 幂等 → cp → server 运行中 source-file 热加载，不重启会话）；手动方式 `cp ~/.pi/deploy/tmux/tmux.conf ~/.tmux.conf`（仓库已带配置，含状态栏脚本） |
| 会话历史（`agent/sessions/`） | 新机无原机会话 | 原机 `pi-backup create --include-sessions` 归档恢复；git 模式**永不**含会话 |
| 运行时日志（`logs/`） | 无法跨机排查问题 | 不入库，原机直接查看 |

**重建后验证：**

```bash
# 配置校验
python3 -c "import json; json.load(open('agent/settings.json'))" && echo "settings.json OK"
python3 -c "import yaml; yaml.safe_load(open('searxng/settings.yml'))" && echo "settings.yml OK"

# 端到端冒烟（SearXNG/whisper 转写/浏览器/tmux/记忆/补丁状态）
bash scripts/smoke-test.sh

# 核心依赖
ls agent/bin/fd agent/bin/rg && echo "binaries OK"
ls agent/extensions/pi-browser/node_modules/ | wc -l

# SearXNG
ls searxng/venv/bin/python && echo "venv OK"
ls searxng/repo/.git && echo "repo OK"

# 定时任务
ls agent/extensions/pi-autopilot/node_modules/ | wc -l
crontab -l | grep pi-cron && echo "crontab OK"

# 持久记忆
ls memory/entries.json && echo "memory OK"

# 端到端冒烟测试（扩展全部加载 + 模型应答；失败会指明具体扩展）
timeout 90 pi -p "回复 OK" && echo "smoke OK"

# PI_DIST（wrapper 自动导出；补丁脚本与 pi-voice 依赖它定位 dist）
echo "$PI_DIST"

```

## 自主运行（pi-autopilot）

`pi-autopilot` 融合了原 pi-scheduler（定时任务）与 pi-admin（自管理），并增加失败自愈闭环，目标是让 Pi 无人值守自驱动运行：

### 定时任务

| 类型 | 命令 | 说明 |
|------|------|------|
| interval | `/loop 5m check build` | 固定间隔循环，创建后立即执行一次 |
| cron | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron |
| once | `/remind +30m review PR` | 一次性提醒，执行后自动禁用 |

**会话内执行：** Pi 运行时由扩展 1s 轮询引擎直接触发，注入为用户消息。

**离线执行：** Pi 关闭后，系统 cron 每分钟调用 `pi-cron.sh` → `pi -p "<prompt>"` print 模式执行 → 记日志。下次进入 Pi 时在 TUI 顶部显示离线执行摘要。

**通知链：**
- 日志文件：`logs/scheduler/<name>-<ts>.log`
- 会话摘要：`session_start` 时 TUI 顶部显示离线执行摘要
- 邮件/webhook：`settings.mailTo` / `settings.webhookUrl`（或环境变量 `PI_SCHEDULER_MAIL_TO` / `PI_SCHEDULER_WEBHOOK`），任务完成且 `notifyOnCompletion` 时由 `pi-cron.sh` 经 `mail`/`curl` 发送（此通知链由离线脚本承载，与 pi-autopilot 扩展内置的通知复用同一配置字段）

### 失败自愈

任务执行失败时按错误分类自动决策：

| 错误类别 | 判定 | 处置 |
|---------|------|------|
| 超时 | exit 124 | 按重试次数重试，耗尽后切备选模型 |
| 服务不可用 | provider/api/connection/429/503 等 | failoverAfter 次后切换 fallback 模型链 |
| 逻辑错误 | Error:/invalid 等 | 直接失败（不烧重启成本） |
| 连续失败 | failCount ≥ suspendAfter(5) | 自动暂停任务 + webhook 告警 |

- **模型 failover：** 配置 `fallbackModels` 白名单后自动切换（结合历史成功率排序），切换即重启会话（wrapper 带 `--model` 拉起）
- **看门狗：** 会话超过 `maxIdleMinutes` 无活动自动重启恢复
- **崩溃回滚：** wrapper 检测连续 3 次崩溃后回滚至最近一次良好模型（lastGood 快照）
- **预算三锁：** `maxRunsPerDay`（默认 50）/ `maxCostPerDay` / `allowedModels`，超限自动跳过并通知

### 自管理

`/auto <status|stats|policy|failover|pause|resume|restart>`（自管理，`/auto help` 查看用法）与 `/schedule`（定时任务）；工具 `autopilot_*`（status/stats/policy/failover）+ `admin_*`（status/model/session/config/restart）同名兼容。

**策略/预算仅 `/auto policy` 命令可写**（工具只读，防止 Agent 自我豁免）。

**配置：** `.pi-autopilot-config.json`（首次自动生成）；状态/遥测：`.pi-autopilot-telemetry.json`（1000 条上限）、`.pi-autopilot-lastgood.json`、`.pi-autopilot-crash.json`。

**安装：**
```bash
bash scripts/install-cron.sh           # 安装 crontab（每分钟）
bash scripts/install-systemd.sh        # 或安装 systemd timer
```

## 持久记忆（pi-memory）

`pi-memory` 扩展（已合并 ctx-lite）提供跨会话持久记忆 + 自主学习闭环：

| 工具 | 功能 |
|------|------|
| `memory_store` | 存储一条知识（自动去重：标题精确匹配 → 更新，内容 Jaccard>0.7 → 合并） |
| `memory_search` | 搜索已存储的记忆（BM25 词法 + 置信度×时效×引用频率混合排序） |
| `memory_recall` | 综合回忆：记忆检索 + 会话摘要时间线（`summaries:true`） |
| `memory_stats` | 查看记忆库统计信息 |
| `memory_forget` | 删除记忆（按 ID 精确删除或按类别+时间批量删除） |
| `ctx_exec/ctx_note/ctx_list/ctx_snap` | ctx-lite 迁移工具（同名同行为） |

**自主学习闭环：**
- **自动提取** — compaction / 会话结束时 LLM 分析会话，提取决策/事实/偏好/约定/教训入长期记忆（`pi -p` 离线通道，失败静默，同会话幂等）
- **自动消解** — Mem0 式四操作（ADD/UPDATE/DELETE/NOOP），同类别同标签冲突时新结论取代旧结论（标记 superseded）
- **每轮常驻注入** — `before_agent_start` 把 ~500 token「持续记忆」块拼入 system prompt（高价值条目 + 最近会话摘要衔接），预算可用 `PI_MEMORY_INJECT_TOKENS` 调整
- **手动触发** — `/memory summary` 查看摘要时间线；`/memory search` 手动检索（提取为自动流程；`/memory help` 查看全部子命令）

**文件位置：** `memory/`（entries.json 1 MB 上限 / notes.json / summaries.json / checkpoints/——检查点为瞬时快照，不入 git），ctx-lite 旧数据自动迁移。

**数据流：**
```
会话中新知识 → memory_store / 自动提取 → 四操作消解入库 → 每轮常驻注入 → 跨会话复用
compaction 前 → 快照 + 异步提取 → 摘要衔接 → 压缩后上下文连续
```

**清理：** `/memory prune` 删除低置信度 + 长期未访问条目；`/memory cleanup` 清理过期笔记/检查点。

**安装：** 零外部依赖，注册到 `settings.json` 后即生效。无需额外安装步骤。

## 子代理（subagent）

`subagent` 扩展提供将任务委托给专门 agent 的能力，每个子代理运行在独立 `pi` 进程中，拥有隔离的上下文窗口。

### Agent 定义

| Agent | 工具 | 用途 |
|-------|------|------|
| `scout` | read, grep, find, ls, bash | 快速代码探测，返回压缩后的上下文摘要 |
| `worker` | 全部 | 通用执行 agent，处理实际修改 |
| `reviewer` | read, grep, find, ls, bash | 代码审查，评估质量和安全性 |

### 三种调用模式

```json
// 单 agent
{ "agent": "scout", "task": "Find all authentication code" }

// 并行（最多 8 任务，默认串行）
{ "tasks": [
  { "agent": "scout", "task": "Find models" },
  { "agent": "scout", "task": "Find providers" }
]}

// 链式（{previous} 占位符传递上一步输出）
{ "chain": [
  { "agent": "scout", "task": "Find all code for X" },
  { "agent": "planner", "task": "Plan improvements using: {previous}" },
  { "agent": "worker", "task": "Implement: {previous}" }
]}
```

### 链式调用

多步流程通过 `{previous}` 占位符串联上一步输出（如 scout 探测 → worker 实现 → reviewer 审查）。链式流程所需 agent 均可自由组合，无需预定义工作流命令。

### 为什么子代理能省钱

子代理使用独立上下文窗口，主 agent 只需消费压缩后的摘要而非原始文件。在需要探索多个文件或执行独立任务时，隔离上下文避免了主 context 膨胀，变相降低 token 消耗。

### 注意事项

- 所有 agent 默认使用 `settings.json` 中配置的主模型，无需单独指定
- 并行模式默认串行执行（`MAX_CONCURRENCY=1`），避免多进程竞争 GPU 内存。如需并行，修改 `agent/extensions/subagent/index.ts` 中的 `MAX_CONCURRENCY`

## 主动路由 + 上下文优化（pi-context，已融合 pi-router）

pi-context 作为 token 优化中枢，通过 `before_agent_start` 事件在每轮 LLM 调用前按需注入内容到 system prompt，并注册 4 个事件处理器 + 1 个命令。

### 主动路由策略表

告知模型何时使用子代理、何时并行、何时 chain，包含具体决策启发式规则（"如果 context 压力档位为高就 delegate"）。该段为**固定静态文案**（无实时数字），配合深度缓存前缀命中。

### 缓存友好的动态压力提示

```
[上下文压力较高（>85%）。优先将探索/独立任务委托给 subagent，关键信息用 ctx_note 保存。]
```

实时占用率仅做档位判断：空闲/中（<85%）**不注入**任何行；≥85% 注入固定文案；≥95% 注入更重文案。文案不含精确数字、不含时间戳 → system prompt 在档位内逐字节稳定，前缀缓存全程命中。

**依赖：** 需要 `subagent` 扩展和 agent 定义配合。

### Token 优化（R2/R3/R4/R6）

全程零用户感知的 token 节省层：

| # | Hook | 作用 | 节省量 |
|---|------|------|--------|
| R2 | `context` | compaction summary 去重，只留最新一份 | 500-1500 tokens/turn |
| R3 | `context` | 旧 turn（>2 轮）的 thinking 块剪枝 | 10-50% 旧 assistant 消息 |
| R4 | `tool_result` | bash/read 输出 >5000 字符时截断 | 50-80% 工具结果 |
| R6 | 命令 | `/usage-diag` 用量诊断（免 LLM 响应） | 单次完全省掉 |

R3 负责 thinking 剪枝（保留最近 2 轮供推理）。R4 仅当输出 >5000 字符时生效：bash 用 `truncateTail`（保留末尾结果）、read 用 `truncateHead`（保留开头）。工具输出统一经 `lib/context-budget.ts` 记账（默认 20K tokens 输出预算 / 5K per-tool），并聚合缓存命中统计（`recordCacheUsage`）。

### 长任务会话拆分

单次会话跨长时间（如数小时、数十轮工具循环）会把上下文累积到数万 token，每次请求都全量重发历史，是 token 消耗的最大来源。建议：

- **按阶段拆会话**：一个会话聚焦一个阶段任务（侦察/规划/实现/验证），完成后新开会话继续，避免单会话无限累积。
- **提前压缩**：长会话中当上下文接近窗口（compaction 触发线 = 窗口 − `compaction.reserveTokens`，默认配置已调至 32768）时，主动 `/compact` 压缩历史。
- **批量执行**：引导 agent 合并多次 bash 为单次调用，减少固化进历史的碎工具调用（见 APPEND_SYSTEM.md）。

## 语音交流（pi-voice）

Termux/Android 双向语音：麦克风录音 → 本地 faster-whisper 转写 → 语音输入（插入输入框或直发）；回复 TTS 自动朗读。入口 `Ctrl+Alt+R` 或 `/voice`：开始/停止录音并转写；**听写模式**录音中按回车切段转写；支持 `/voice <start|stop|cancel|tts|doctor|model|bench>` 与 `/voice tts status` 诊断。转写完全本地、离线可用。依赖 `pi-whisper.sh`（常驻服务）与 Termux:API。配置 `agent/pi-voice.json`（`PI_VOICE_*` 环境变量）；详见 `agent/extensions/pi-voice/README.md`。

## 后台任务与 tmux（pi-tmux / pi-bg.sh）

`pi-tmux` 扩展提供 tmux 会话管理（`tmux_run/read/wait/send/status`），适合长任务/dev server/交互程序：detached 运行、日志落盘、不阻塞对话。`scripts/pi-bg.sh` 提供后台任务四件套隔离（--no-session + --no-extensions + 只读工具集 + 独立日志），详见 `scripts/README-pi-bg.md` 与 `agent/extensions/pi-tmux/README.md`。

## Wrapper 生命周期

`pi-wrapper.sh` 是进程外生命周期管理器，确保 Pi 在崩溃后自动重启：

```
pi（bash wrapper）→ pi-wrapper.sh → node cli.js
```

- **`pi-wrapper.sh`** — 检测目标 `cli.js`（优先通过 `pi-original` 符号链接，兜底硬编码路径），以 `node cli.js` 方式启动 Pi。注入 `PI_AUTOPILOT=1` 环境变量；崩溃（非 0 退出）累计计数，连续 3 次自动回滚至 lastGood 模型并重启；正常退出记录 lastGood 快照并清零计数；5 分钟内仅回滚一次防死循环。
- **`install-wrapper.sh`** — 安装/卸载 wrapper。安装时把原 `pi` 命令重命名为 `pi-original`，将 wrapper 脚本放置为 `pi`。
- **`pi-orig.sh`** — 绕过 wrapper 直接启动（故障逃生口）。
- **`.bash_aliases`** — 提供 `pic`（继续会话）、`pir`（重启会话）、`piorg`（直启）三个便捷别名（手动维护于 `~/.bash_aliases`，wrapper 安装脚本不负责写入）。

**安装：** `bash scripts/install-wrapper.sh`

## 测试与回归

一键全量回归（5 套测试 + 类型检查 + 扩展冲突检查 + 注册完整性）：

```bash
bash scripts/test-all.sh
```

| 套件 | 命令 | 用例数 |
|------|------|--------|
| pi-web-search | `cd agent/extensions/pi-web-search && ./node_modules/.bin/vitest run` | 72 |
| pi-memory | `cd agent/extensions/pi-memory && ./node_modules/.bin/vitest run` | 49 |
| pi-autopilot | `cd agent/extensions/pi-autopilot && ./node_modules/.bin/vitest run` | 86 |
| pi-browser | `cd agent/extensions/pi-browser && ./node_modules/.bin/vitest run` | 23 |
| subagent | `cd agent/extensions/subagent && node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs` | 34 |
| 类型检查 | `cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit` | — |
| 冲突检查 | `cd agent/extensions && node tests/conflict-check.mjs` | 6 项 |

**约定：** 新增/修改扩展必须同步 `settings.json` extensions、`extensions/tsconfig.json` include、`tests/conflict-check.mjs` 监听者清单，并保持各套件用例全绿。

## ⚠ 安全注意事项

### 密钥文件（永远不要提交到 git）

| 文件 | 内容 | 保护机制 |
|------|------|---------|
| `agent/auth.json` | DeepSeek API key 等 | `.gitignore` 排除 |
| `agent/trust.json` | 项目信任设置 | `.gitignore` 排除 |
| `searxng/settings.yml` | SearXNG secret_key | `.gitignore` 排除（可用 `generate-config.sh` 重新生成） |

`pi-backup sync` 在 commit 前会自动检测 `auth.json` 是否被 git 意外追踪，发现即中止并报警。

### 大文件（git 不追踪，需自动下载）

| 文件 | 大小 | 来源 | 重建方式 |
|------|------|------|---------|
| `searxng/venv/` | ~94 MB | `python3 -m venv` | `scripts/rebuild.sh` 自动创建 |
| `searxng/repo/` | ~28 MB | `git clone searxng/searxng`（--depth 1） | `scripts/rebuild.sh` 自动克隆 |
| `agent/extensions/*/node_modules/` | ~330 MB（4 扩展合计） | `npm install` | `scripts/rebuild.sh` 自动安装 |

## 常见问题

### SearXNG 启动后搜索引擎全部超时

**原因：** 国内 DNS 干扰导致 Google/DuckDuckGo 等站点不可达。

**解决：**
- 重新生成配置：`cd searxng && bash generate-config.sh --force`（自动重启运行中的 SearXNG）
- 环境自适应引擎白名单：`bash generate-config.sh --force --probe`（逐个探测引擎连通性，可达启用/不可达禁用，避免不可达引擎每次搜索白等超时）
- 默认分组（无 --probe）：启用 baidu、bing、sogou、360search、bilibili、yandex、stackoverflow、github，其余引擎 `disabled: true`
- 如需手动启用其他引擎，编辑 `searxng/settings.yml`，将对应引擎的 `disabled` 改为 `false`

### Venv 创建后缺少 pip

**原因：** 系统中未安装 `python3-venv` 包，`python3 -m venv` 创建了空壳。

**解决：** 安装后重新创建：
```bash
apt-get install -y python3-venv
rm -rf ~/.pi/searxng/venv
bash ~/.pi/scripts/rebuild.sh --yes
```

> **空壳判定**：`dpkg -l python3-venv` 显示已装但 `python3 -m venv` 仍报 `ensurepip is not available` 时，说明包是空壳（版本错配），需按实际 Python 版本安装后再重建：
> ```bash
> apt-get install -y python3.12-venv   # 版本号随 python3 -V
> rm -rf ~/.pi/searxng/venv
> bash ~/.pi/scripts/rebuild.sh --yes
> ```
> 前置检查请用实际创建验证（而非 `--help`）：`python3 -m venv /tmp/.venv-probe && rm -rf /tmp/.venv-probe`

### git clone/pull 报证书验证失败（CAfile: none）

**原因：** 企业代理/沙箱/镜像网络拦截 TLS，系统 CA 无法验证 GitHub 证书链（`git`/`curl`/node fetch 均受影响，npm registry 通常不受影响）。

**解决：**
```bash
git config --global http.sslVerify false   # 或单次: git -c http.sslVerify=false clone <url>
```
先尝试修复证书：`apt-get install -y ca-certificates && update-ca-certificates`。受影响的操作：`git clone/pull`、SearXNG repo 克隆、CloakBrowser 下载（后者另需 `NODE_TLS_REJECT_UNAUTHORIZED=0`，见浏览器条目）。

### pi 启动报 "Extension runtime not initialized"（pi-voice 加载失败）

**原因：** wrapper 接管 `pi` 命令后，pi-voice 的 dist 探测（`which pi` + `readlink -f`）解析到 wrapper 脚本本身，硬编码兜底路径又是 arm64 旧版本——探测失败时扩展在加载期调用 `pi.sendMessage`，pi 完全无法启动（`pi -p` 可复现并指明扩展）。

**解决：** 确认 `PI_DIST` 已导出（pi-wrapper.sh 已自动导出，`echo $PI_DIST` 验证）。直启（`pi-original` / node cli.js）时手动：
```bash
export PI_DIST="$(dirname "$(readlink -f "$(which pi-original)")")"
```

### SearXNG 启动失败，提示缺少 Python 模块

**原因：** SearXNG repo 的依赖未完全安装（`rebuild.sh` 现在从 `searxng/repo/requirements.txt` 安装全部依赖，但若克隆 repo 时失败或中断会导致依赖不完整）。

**解决：** 重新运行重建：
```bash
bash ~/.pi/scripts/rebuild.sh --yes
```
或者手动安装缺失模块：
```bash
source ~/.pi/searxng/venv/bin/activate
pip install -r ~/.pi/searxng/repo/requirements.txt
```

### 定时任务没有在指定时间触发

**原因：** Pi 会话已关闭但 cron daemon 未运行，或者 crontab 未安装。

**解决：**
```bash
service cron status                   # 检查 cron daemon 是否运行
crontab -l | grep pi-cron             # 检查 crontab 条目是否存在
bash scripts/install-cron.sh          # 安装或修复 crontab
```

### 离线任务显示"超时"

**原因：** `pi -p` 执行时需要 provider 后端在线。若使用 `local-llama`（localhost:8080），需确保 llama.cpp 等服务在后台运行。

**解决：** 默认 `maxRunTime=300s`，可通过任务配置调整。若 provider 不可预期离线，考虑使用 remote API provider。

### 任务锁文件残留导致新任务不执行

**解决：**
```bash
rm -f agent/scheduler.lock
```

### Chromium/CloakBrowser 浏览器无法启动

**原因：** Chromium 未安装或缺少系统依赖。`rebuild.sh` 的验证步骤会检测并给出提示。

**解决：**
```bash
cd ~/.pi
npx cloakbrowser install          # 安装 chromium（下载报 "fetch failed" 时见下）
apt-get install -y libnspr4 libnss3 libatk1.0-0t64 libcups2t64 libgbm1
```

**`npx cloakbrowser install` 报 "fetch failed"**（沙箱/代理网络无法验证 GitHub/cloakbrowser.dev 证书链，`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）：
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npx cloakbrowser install   # 绕过 TLS 校验，仅限不可信网络环境
```


