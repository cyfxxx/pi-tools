# pi-tools

[Pi Coding Agent](https://pi.dev/) 个人配置文件仓库。

## 目录结构

```
.pi/
├── agent/                        # 核心代理配置与扩展
│   ├── settings.json             # Pi 主配置（provider, model, extensions, skills）
│   ├── AGENTS.md                 # 项目环境描述
│   ├── APPEND_SYSTEM.md          # 追加系统提示词
│   ├── modes.json                # 模式切换配置（full/light/quick）
│   ├── rescue/                   # 救援模式配置
│   │   ├── rescue-config.json    # 救援模式配置（最小化 pi）
│   │   ├── rescue-prompt.md      # 救援模式提示词（修复主程序）
│   │   └── README.md             # 救援模式说明文档
│   │
│   ├── core/                     # Layer 0: 基础层（零依赖）
│   │   ├── config.ts             # 配置加载/合并
│   │   ├── registry.ts           # 注册/清理统一封装
│   │   ├── hook-registry.ts      # 扩展钩子注册表
│   │   ├── secrets.ts            # 密钥脱敏工具
│   │   └── index.ts              # 统一导出
│   │
│   ├── services/                 # Layer 1: 服务层（仅依赖 core）
│   │   ├── token-budget/         # Token 预算管理
│   │   │   ├── context-budget.ts # 统一 Token 预算/估算/裁剪 + 缓存命中统计
│   │   │   ├── prune.ts          # 工具输出裁剪
│   │   │   ├── auto-compact.ts   # 自动压缩触发策略
│   │   │   ├── output-archive.ts # 工具输出归档（写入时预算截断原文落盘）
│   │   │   └── index.ts
│   │   ├── diagnostics/          # 诊断服务
│   │   │   ├── usage-diag.ts     # 用量诊断（/usage-diag 数据源）
│   │   │   ├── task-record.ts    # 结构化任务记录（logs/task-records.jsonl）
│   │   │   └── index.ts
│   │   ├── shadow-review.ts      # 影子代码审查
│   │   ├── note-store.ts         # ctx-lite 笔记持久化
│   │   └── index.ts              # 统一导出
│   │
│   ├── extensions/               # Layer 2: 扩展层（每个扩展独立）
│   │   ├── pi-web-search/        # 网络搜索（SearXNG 私密搜索 + Bing 备选 + HTTP 抓取）
│   │   ├── pi-autopilot/         # 自主运行（定时任务 + 自管理 + 失败自愈：failover/看门狗/遥测/预算）
│   │   │   ├── config/           # 扩展专用配置（.pi-autopilot-config.json, notify.json）
│   │   │   ├── scripts/          # 扩展专用脚本（knowledge-fetch, ntfy-relay, pi-cron, pi-notify, task-metrics）
│   │   │   └── tests/
│   │   ├── pi-browser/           # 浏览器自动化（CloakBrowser，自 pi-web-toolkit 拆出）
│   │   │   └── scripts/          # 扩展专用脚本（patch-playwright-core）
│   │   ├── plan-mode/            # 计划模式（TUI 计划/任务管理）
│   │   │   └── scripts/          # 扩展专用脚本（patch-plan-tools）
│   │   ├── pi-memory/            # 跨会话持久记忆（自主学习闭环）
│   │   │   └── scripts/          # 扩展专用脚本（memory-lifecycle）
│   │   ├── pi-mode/              # 模式切换（full/light/quick/自定义）
│   │   ├── subagent/             # 子代理（delegate 给专门 agent）
│   │   ├── pi-tmux/              # tmux 会话管理（后台任务/长任务）
│   │   │   └── scripts/          # 扩展专用脚本（pi-bg, tmux-fix）
│   │   ├── pi-voice/             # 语音交流（Termux：录音转写 + TTS 朗读）
│   │   │   ├── config/           # 扩展专用配置（pi-voice.json）
│   │   │   └── scripts/          # 扩展专用脚本（pi-whisper, pi-sherpa, whisper-server, patch-voice-enter）
│   │   ├── pi-link/              # 多设备互联（ssh 通道 + 远程 pi RPC，link_send/link_status）
│   │   │   ├── config/           # 扩展专用配置（pi-link.json）
│   │   │   ├── scripts/          # 扩展专用脚本（pi-link-entry, pi-link-keys）
│   │   │   └── tests/
│   │   ├── pi-intervention/      # 干预捕获（abort 快照/corrective prompt 关联/interventions.jsonl）
│   │   └── pi-context/           # token 优化中枢（已融合 pi-router：路由策略注入 + thinking 剪枝/compaction 去重/输出截断 + 缓存统计）
│   │       ├── scripts/          # 扩展专用脚本（核心基础设施（rebuild.sh/test-all.sh/daily-health.mjs/pi-wrapper.sh/usage-stats.mjs/task-summarizer.mjs/check-cache-impact.sh），扩展专用脚本需在各自 extension/scripts/）
│   │       └── tests/
│   │
│   ├── agents/                   # Layer 4: Agent 编排层
│   │   ├── scout.md              # 快速代码探测，返回压缩上下文
│   │   ├── worker.md             # 通用执行 agent
│   │   └── reviewer.md           # 代码审查
│   │
│   ├── prompts/                  # Layer 4: Prompt 模板（*.md 注册为 /name 斜杠命令）
│   │
│   ├── skills/                   # Layer 3: 技能层
│   │   ├── pi-translate-zh/      # 中文翻译
│   │   ├── pi-backup/            # 备份恢复技能（本地归档 + GitHub 同步）
│   │   ├── pi-code-review/       # 代码审查（确定性检查 + 分级报告）
│   │   ├── pi-bug-diagnosis/     # 硬 bug 诊断纪律（紧反馈回路先行）
│   │   ├── pi-full-audit/        # 全项目深度审计（确定性检查 + 回归 + 并行审查 + 复核）
│   │   └── pi-repo-optimize/     # 配置仓库结构/存储/架构优化
│   │
│   ├── lib/                      # 兼容层（保留 2 周，2026-09-23 清理）
│   │   └── index.ts              # 重导出 core/ + services/
│   │
│   ├── package.json              # 统一依赖根（12 扩展共享 agent/node_modules）
│   ├── sessions/                 # 运行时：会话数据（git 忽略）
│   └── stats/                    # 运行时：统计（git 忽略）
│
├── packs/                        # 外部技能包
│   ├── <name>/                   # 技能包
│   └── drafts/                   # 技能草稿
│
├── scripts/                      # 核心基础设施脚本
│   ├── rebuild.sh                # 一键重建（幂等、并行、镜像加速）
│   ├── test-all.sh               # 一键全量回归
│   ├── install/                  # 安装脚本（cron/systemd/wrapper）
│   ├── utils/                    # 工具脚本（smoke-test/pi-bench/docker-rebuild-test 等）
│   └── *.mjs                     # 基础设施脚本（verify-patches 等）
│
├── data/                         # 运行时数据（symlink 保持旧路径兼容）
│   ├── memory/                   # pi-memory 长期记忆（entries.json 入库共享）
│   ├── logs/                     # 运行时日志（scheduler/ 等）
│   └── plans/                    # plan-mode 计划存档（每计划独立 .git）
│
├── docs/                         # 文档（按职责分类）
│   ├── design/                   # 设计文档（VISION.md, MODULARIZATION-PLAN.md 等）
│   ├── development/              # 开发文档（AGENTS-DETAILS.md, PI-EXT-DEV-NOTES.md 等）
│   ├── operations/               # 运维文档（ENVIRONMENTS.md, GIT-HISTORY-REWRITE.md 等）
│   └── maintenance/              # 维护文档（OPTIMIZATION-LOG.md, SKILLS-MAINTENANCE.md 等）
│
├── deploy/                       # 部署配置（systemd/tmux/keys）
├── searxng/                      # SearXNG 自托管搜索（settings.yml 含密钥，git 忽略）
├── portable/                     # 便携 pi（Windows 原生）种子
├── .github/                      # GitHub Actions CI
└── README.md                     # 本文件
```

## 分层架构

```
Layer 4 ─ Agent 编排层 ─────── agent/agents/ agent/prompts/
    ↑
Layer 3 ─ 技能层 ───────────── agent/skills/ packs/
    ↑
Layer 2 ─ 扩展层 ───────────── agent/extensions/ (每个扩展独立)
    ↑
Layer 1 ─ 服务层 ───────────── agent/services/ (token-budget, diagnostics)
    ↑
Layer 0 ─ 基础层 ───────────── agent/core/ (config, registry, secrets)
```

**依赖规则**：单向（下层不能依赖上层）+ 同层独立（扩展之间禁止相互依赖）

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

- **幂等** — 已存在项跳过，只重建缺失内容
- **国内镜像加速** — 自动检测并切换 apt/npm/pip/GitHub 镜像
- **Node.js 自动升级** — 检测到 <20 时自动安装 22.x
- **并行执行** — npm 依赖、venv、SearXNG repo 三路并行
- **浏览器自动安装** — pi-browser 扩展存在时自动安装 CloakBrowser Chromium
- **自动补全配置** — 自动生成 `searxng/settings.yml`；`settings.json` 的 `packages` 依赖自动合并进 `agent/package.json`
- **格式校验** — 重建后自动验证 YAML/JSON 配置文件
- **TUI 补丁自动定位 dist** — 补丁脚本不再依赖 `which pi`
- **补丁版本关联** — Phase 3 先跑 `verify-patches.mjs`：核对 patch 头部声明的 `@target-version` 与当前 pi 版本
- **日志与退出码** — `--yes` 模式自动落盘 `logs/rebuild-<ts>.log`

### Windows 原生便携安装（pi-portable）

不想在 Windows 主机上安装、又想原生运行 pi 时，使用便携包：

1. 新建空文件夹，放入 `portable/` 下全部脚本；从本机拷贝配置
2. PowerShell 运行 `bin\setup.ps1`
3. **必须** `bin\verify.ps1` 验证环境 → 全部通过后再启动
4. `start.bat --continue` 恢复会话

> ⚠ 迁移/重建后**跳过 verify.ps1 直接启动**是已知事故源。

关键机制（详见 `portable/README.md`）：

- **USERPROFILE=包根** + **PI_CODING_AGENT_DIR 显式** — 配置/扩展/会话全落包内
- **显式 `node.exe` 调 cli.js** — 绕开 npm shim 的 node 解析
- **完全脱离 WSL** — bash 工具 = PortableGit Git Bash
- **wrapper 自动重启** — start.bat 循环 + check-restart.js

### 新设备恢复引导

```bash
git clone https://github.com/cyfxxx/pi-tools.git ~/.pi
cd ~/.pi && bash scripts/rebuild.sh --yes
bash scripts/install/install-wrapper.sh   # 可选：安装自动重启 wrapper
```

> **`~/.pi/` 已存在时**：`git clone` 到非空目录会失败；不要直接 `rm -rf ~/.pi`。建议先 `mv ~/.pi ~/.pi.bak` 再克隆。

**前置条件：**

| 检查项 | 要求 | 验证命令 |
|--------|------|---------|
| Node.js | >= 20 | `node -v` |
| npm | 随 Node 自带 | `npm -v` |
| python3 + venv | >= 3.10 | `python3 -m venv /tmp/.venv-probe && rm -rf /tmp/.venv-probe && echo ok` |
| git | 任意版本 | `git --version` |
| ca-certificates | 已安装 | `dpkg -l ca-certificates` |
| 磁盘空间 | >= 2GB 可用 | `df -h .` |

**git 模式边界（缺失项，需手动提供）：**

| 缺失项 | 后果 | 补救 |
|--------|------|------|
| `agent/settings.json` + `models.json` | pi 无模型配置，无法启动 | 原机 `scp` 或 `pi-backup restore` |
| `agent/auth.json` | 无 API 凭据 | 同上 |
| `agent/pi-voice.json` | 语音扩展/whisper token 不一致 | 原机拷贝 |
| `~/.tmux.conf` | tmux 无 `extended-keys` | **`rebuild.sh` 已自动同步** |
| 会话历史（`agent/sessions/`） | 新机无原机会话 | `pi-backup create --include-sessions` |
| 运行时日志（`logs/`） | 无法跨机排查问题 | 不入库，原机直接查看 |

**重建后验证：**

```bash
# 配置校验
python3 -c "import json; json.load(open('agent/settings.json'))" && echo "settings.json OK"
python3 -c "import yaml; yaml.safe_load(open('searxng/settings.yml'))" && echo "settings.yml OK"

# 端到端冒烟
bash scripts/utils/smoke-test.sh

# 核心依赖
ls agent/bin/fd agent/bin/rg && echo "binaries OK"

# 持久记忆
ls data/memory/entries.json && echo "memory OK"

# 端到端冒烟测试
timeout 90 pi -p "回复 OK" && echo "smoke OK"
```

## 自主运行（pi-autopilot）

`pi-autopilot` 融合了原 pi-scheduler（定时任务）与 pi-admin（自管理），并增加失败自愈闭环：

### 定时任务

| 类型 | 命令 | 说明 |
|------|------|------|
| interval | `/loop 5m check build` | 固定间隔循环 |
| cron | `/schedule cron "0 9 * * 1-5" standup` | 5 字段 POSIX cron |
| once | `/remind +30m review PR` | 一次性提醒 |

**离线执行：** 系统 cron 每分钟调用 `pi-cron.sh` → `pi -p "<prompt>"` print 模式执行 → 记日志。

**通知链：**
- 日志文件：`data/logs/scheduler/<name>-<ts>.log`
- 会话摘要：`session_start` 时 TUI 顶部显示离线执行摘要

### 失败自愈

| 错误类别 | 判定 | 处置 |
|---------|------|------|
| 超时 | exit 124 | 按重试次数重试，耗尽后切备选模型 |
| 服务不可用 | provider/api/connection/429/503 等 | failoverAfter 次后切换 fallback 模型链 |
| 逻辑错误 | Error:/invalid 等 | 直接失败 |
| 连续失败 | failCount ≥ suspendAfter(5) | 自动暂停任务 + webhook 告警 |

- **模型 failover：** 配置 `fallbackModels` 白名单后自动切换
- **看门狗：** 会话超过 `maxIdleMinutes` 无活动自动重启恢复
- **崩溃回滚：** wrapper 检测连续 3 次崩溃后回滚至最近一次良好模型
- **预算三锁：** `maxRunsPerDay` / `maxCostPerDay` / `allowedModels`

### 救援模式

| 崩溃次数 | 恢复措施 | 说明 |
|---------|---------|------|
| 3-4 次 | 回滚 lastGood 模型 | 现有逻辑 |
| 5-6 次 | 恢复配置文件 | 从快照或 git 恢复 |
| 7+ 次 | 启动救援模式 pi | 最小化配置，用于修复问题 |

**手动救援**：
```bash
bash scripts/test/test-recovery.sh    # 手动救援测试
```

### 自管理

`/auto <status|stats|policy|failover|pause|resume|restart>`（自管理）

**配置：** `.pi-autopilot-config.json`（在 `agent/extensions/pi-autopilot/config/` 下）

**安装：**
```bash
bash scripts/install/install-cron.sh           # 安装 crontab（每分钟）
bash scripts/install/install-systemd.sh        # 或安装 systemd timer
```

## 持久记忆（pi-memory）

`pi-memory` 扩展提供跨会话持久记忆 + 自主学习闭环：

| 工具 | 功能 |
|------|------|
| `memory_store` | 存储一条知识（自动去重） |
| `memory_search` | 搜索已存储的记忆 |
| `memory_recall` | 综合回忆：记忆检索 + 会话摘要时间线 |
| `memory_stats` | 查看记忆库统计信息 |
| `memory_forget` | 删除记忆 |
| `ctx_exec/ctx_note/ctx_list/ctx_snap` | 跨对话便笺 |

**数据位置：** `data/memory/`（symlink 保持 `memory/` 旧路径兼容）

## 子代理（subagent）

`subagent` 扩展提供将任务委托给专门 agent 的能力：

### Agent 定义

| Agent | 工具 | 用途 |
|-------|------|------|
| `scout` | read, grep, find, ls, bash | 快速代码探测 |
| `worker` | 全部 | 通用执行 agent |
| `reviewer` | read, grep, find, ls, bash | 代码审查 |

### 三种调用模式

```json
// 单 agent
{ "agent": "scout", "task": "Find all authentication code" }

// 并行
{ "tasks": [
  { "agent": "scout", "task": "Find models" },
  { "agent": "scout", "task": "Find providers" }
]}

// 链式
{ "chain": [
  { "agent": "scout", "task": "Find all code for X" },
  { "agent": "worker", "task": "Implement: {previous}" }
]}
```

## 上下文优化（pi-context）

pi-context 作为 token 优化中枢：

| # | Hook | 作用 | 节省量 |
|---|------|------|--------|
| R2 | `context` | compaction summary 去重 | 500-1500 tokens/turn |
| R3 | `context` | thinking 块按 token 预算剪枝 | 10-50% 旧 assistant 消息 |
| R4 | `tool_result` | bash/read 输出截断 | 50-80% 工具结果 |
| R6 | 命令 | `/usage-diag` 用量诊断 | 单次完全省掉 |

### 长任务会话拆分

单次会话跨长时间会把上下文累积到数万 token。建议：
- **按阶段拆会话**
- **提前压缩**（`/compact`）
- **批量执行**（合并多次 bash 为单次调用）

## 语音交流（pi-voice）

Termux/Android 双向语音：麦克风录音 → 本地 faster-whisper 转写 → 语音输入；回复 TTS 自动朗读。入口 `Ctrl+Alt+R` 或 `/voice`。配置 `agent/pi-voice.json`。

## 后台任务与 tmux（pi-tmux / pi-bg.sh）

`pi-tmux` 扩展提供 tmux 会话管理（`tmux_run/read/wait/send/status`），适合长任务/dev server/交互程序。

## Wrapper 生命周期

`pi-wrapper.sh` 是进程外生命周期管理器：

```
pi（bash wrapper）→ pi-wrapper.sh → node cli.js
```

- **`pi-wrapper.sh`** — 检测目标 `cli.js`，以 `node cli.js` 方式启动 Pi
- **`install/install-wrapper.sh`** — 安装/卸载 wrapper
- **`pi-orig.sh`** — 绕过 wrapper 直接启动（故障逃生口）

**安装：** `bash scripts/install/install-wrapper.sh`

## 测试与回归

一键全量回归：

```bash
bash scripts/test/test-all.sh
```

| 套件 | 命令 | 用例数 |
|------|------|--------|
| pi-web-search | `cd agent/extensions/pi-web-search && ../../node_modules/vitest/vitest.mjs run` | 75+ |
| pi-memory | `cd agent/extensions/pi-memory && ../../node_modules/vitest/vitest.mjs run` | 94+ |
| pi-autopilot | `cd agent/extensions/pi-autopilot && ../../node_modules/vitest/vitest.mjs run` | 106+ |
| pi-browser | `cd agent/extensions/pi-browser && ../../node_modules/vitest/vitest.mjs run` | 25+ |
| pi-context | `cd agent/extensions/pi-context && ../../node_modules/vitest/vitest.mjs run` | 92 |
| plan-mode | `cd agent/extensions/plan-mode && ../../node_modules/vitest/vitest.mjs run` | 72 |
| pi-tmux | `cd agent/extensions/pi-tmux && ../../node_modules/vitest/vitest.mjs run` | 20+2 跳过 |
| pi-voice | `cd agent/extensions/pi-voice && ../../node_modules/vitest/vitest.mjs run` | 128+ |
| pi-link | `cd agent/extensions/pi-link && ../../node_modules/vitest/vitest.mjs run` | 58 |
| pi-intervention | `cd agent/extensions/pi-intervention && ../../node_modules/vitest/vitest.mjs run` | 5 |
| subagent | `cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs` | 63+7 |
| 注册面 | `cd agent/extensions/pi-web-search && ../../node_modules/vitest/vitest.mjs run tests/extensions.test.ts` | 25 |
| 类型检查 | `cd agent/extensions && ../node_modules/typescript/bin/tsc -p tsconfig.local.json --noEmit` | — |
| 冲突检查 | `cd agent/extensions && node tests/conflict-check.mjs` | 9 项 |
| 缓存注入面守门 | `cd agent/extensions && node tests/cache-guard.mjs` | 注入面指纹/阈值契约 |

## 深度文档索引

按需加载：问题驱动，先查索引再读文档。

| 主题 | 文档 | 适用场景 |
|------|------|----------|
| 扩展开发规范 | `docs/development/PI-EXT-DEV-NOTES.md` | 开发新扩展、踩坑排查 |
| SDK 扩展开发 | `docs/development/PI-SDK-EXTENSION.md` | 需要 SDK 深度定制 |
| 多环境配置 | `docs/operations/ENVIRONMENTS.md` | 跨设备配置同步 |
| Termux 开发 | `docs/operations/TERMUX-DEV-NOTES.md` | Android 录音/语音问题 |
| 项目愿景 | `docs/design/VISION.md` | 理解设计决策 |
| 模块化方案 | `docs/maintenance/MODULARIZATION-PLAN.md` | 架构重构 |
| 故障排除 | `docs/TROUBLESHOOTING.md` | 常见问题诊断 |

> **防止上下文膨胀**：不要一次性加载所有文档，只在需要时 read 对应文件。

## ⚠ 安全注意事项

### 密钥文件（永远不要提交到 git）

| 文件 | 内容 | 保护机制 |
|------|------|---------|
| `agent/auth.json` | DeepSeek API key 等 | `.gitignore` 排除 |
| `agent/trust.json` | 项目信任设置 | `.gitignore` 排除 |
| `searxng/settings.yml` | SearXNG secret_key | `.gitignore` 排除 |

### 大文件（git 不追踪，需自动下载）

| 文件 | 大小 | 来源 | 重建方式 |
|------|------|------|---------|
| `searxng/venv/` | ~94 MB | `python3 -m venv` | `scripts/rebuild.sh` 自动创建 |
| `searxng/repo/` | ~28 MB | `git clone searxng/searxng` | `scripts/rebuild.sh` 自动克隆 |
| `agent/node_modules/` | ~135 MB | `npm install` | `scripts/rebuild.sh` 自动安装 |

## 常见问题

### SearXNG 启动后搜索引擎全部超时

**原因：** 国内 DNS 干扰导致 Google/DuckDuckGo 等站点不可达。

**解决：**
```bash
cd searxng && bash generate-config.sh --force
```

### Venv 创建后缺少 pip

**原因：** 系统中未安装 `python3-venv` 包。

**解决：**
```bash
apt-get install -y python3-venv
rm -rf ~/.pi/searxng/venv
bash ~/.pi/scripts/rebuild.sh --yes
```

### pi 启动报 "Extension runtime not initialized"

**原因：** wrapper 接管 `pi` 命令后，pi-voice 的 dist 探测失败。

**解决：** 确认 `PI_DIST` 已导出：
```bash
echo $PI_DIST
```

### SearXNG 启动失败，提示缺少 Python 模块

**解决：** 重新运行重建：
```bash
bash ~/.pi/scripts/rebuild.sh --yes
```

### 定时任务没有在指定时间触发

**解决：**
```bash
service cron status
crontab -l | grep pi-cron
bash scripts/install/install-cron.sh
```

### 任务锁文件残留导致新任务不执行

**解决：**
```bash
rm -f agent/scheduler.lock
```

### Chromium/CloakBrowser 浏览器无法启动

**解决：**
```bash
cd ~/.pi/agent
npx cloakbrowser install
apt-get install -y libnspr4 libnss3 libatk1.0-0t64 libcups2t64 libgbm1
```
