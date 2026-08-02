# pi-tools

[Pi Coding Agent](https://pi.dev/) 个人配置文件仓库。

## 结构

```
├── agent/
│   ├── settings.json          Pi 主配置（provider, model, extensions, skills）
│   ├── AGENTS.md              项目环境描述
│   ├── APPEND_SYSTEM.md       追加系统提示词
│   ├── lib/                   共享库模块
│   │   ├── token-budget.ts    跨扩展 Token 用量追踪
│   │   ├── note-store.ts      ctx-lite 笔记持久化
│   │   ├── prune.ts           工具输出裁剪
│   │   ├── TOKEN-BUDGET.md    使用文档
│   │   └── tests/             单元测试
│   ├── extensions/            自定义扩展
│   │   ├── pi-web-toolkit/    浏览器自动化 + 搜索
│   │   ├── pi-autopilot/      自主运行（定时任务 + 自管理 + 失败自愈：failover/看门狗/遥测/预算）
│   │   ├── ctx-lite/          轻量上下文笔记
│   │   ├── plan-mode/         计划模式
│   │   ├── pi-memory/         跨会话持久记忆
│   │   ├── subagent/          子代理（delegate 给专门 agent）
│   │   ├── pi-router/         before_agent_start 注入主动路由策略 + token 预算
│   │   └── pi-context-efficiency/  token 优化（thinking 剪枝/compaction 去重/输出截断）
│   ├── agents/                agent 定义（子代理模板）
│   │   ├── scout.md              快速代码探测，返回压缩上下文
│   │   ├── planner.md            实现计划生成
│   │   ├── worker.md             通用执行 agent
│   │   └── reviewer.md           代码审查
│   ├── prompts/               工作流 prompt（子代理 chain 模板）
│   │   ├── implement.md       完整实现流：scout→planner→worker
│   │   ├── scout-and-plan.md  探测+计划：scout→planner
│   │   └── implement-and-review.md  实现+审查：worker→reviewer→worker
│   ├── skills/                自定义技能
│   │   ├── pi-translate-zh/   中文翻译
│   │   └── pi-backup/         备份恢复技能（本地归档 + GitHub 同步）
│   └── npm/
│       ├── package.json       npm 包声明
│       └── .gitignore         只排除 node_modules/ 和 package-lock.json
├── ctx-lite/                  ctx-lite 运行时数据（checkpoints）
│   └── checkpoints/           笔记检查点
├── memory/                    pi-memory 运行时数据
├── searxng/                   SearXNG 自托管搜索引擎
│   ├── settings.yml           SearXNG 配置（含 secret_key）
│   ├── generate-config.sh     settings.yml 自动生成脚本
│   ├── start.sh               启动脚本
│   └── stop.sh                停止脚本
├── scripts/
│   ├── rebuild.sh             一键重建脚本（幂等、并行下载、国内镜像加速）
│   ├── pi-cron.sh             pi-scheduler 离线执行包装脚本
│   ├── install-cron.sh        安装 crontab 条目
│   ├── install-systemd.sh     安装 systemd timer（备选）
│   ├── pi-wrapper.sh          进程外生命周期管理器（自动重启）
│   ├── install-wrapper.sh     wrapper 安装/卸载
│   └── pi-orig.sh             绕过 wrapper 直启（故障逃生）
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
```

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
- **并发下载** — fd/rg、SearXNG 等多组件同时下载
- **自动补全配置** — 自动生成 `searxng/settings.yml`、`agent/npm/package.json`（如缺失）
- **格式校验** — 重建后自动验证 YAML/JSON 配置文件

支持自动下载/重建：npm 依赖、扩展依赖、fd/rg 二进制、SearXNG venv、SearXNG 源码（从 repo `requirements.txt` 安装全部依赖）。

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
- 会话摘要：`session_start` 时 TUI 显示
- 邮件：设置 `PI_SCHEDULER_MAIL_TO` 环境变量
- Webhook：设置 `PI_SCHEDULER_WEBHOOK` 环境变量

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

`/admin:status`、`/admin:model`、`/admin:session`、`/admin:config`、`/admin:restart`（工具 `admin_*` 同名兼容）；新增 `/auto:status`、`/auto:stats`、`/auto:policy set <path> <value>`、`/auto:failover --exec`、`/auto:pause`、`/auto:resume`。

**策略/预算仅 `/auto:policy` 命令可写**（工具只读，防止 Agent 自我豁免）。

**配置：** `.pi-autopilot-config.json`（首次自动生成）；状态/遥测：`.pi-autopilot-telemetry.json`（1000 条上限）、`.pi-autopilot-lastgood.json`、`.pi-autopilot-crash.json`。

**安装：**
```bash
bash scripts/install-cron.sh           # 安装 crontab（每分钟）
bash scripts/install-systemd.sh        # 或安装 systemd timer
```

## 持久记忆（pi-memory）

`pi-memory` 扩展提供跨会话持久记忆能力，让 LLM 记住学到的知识和用户偏好：

| 工具 | 功能 |
|------|------|
| `memory_store` | 存储一条知识（自动去重：标题精确匹配 → 更新，内容 Jaccard>0.7 → 合并） |
| `memory_search` | 搜索已存储的记忆（按置信度×时效性×引用频率排序） |
| `memory_stats` | 查看记忆库统计信息 |
| `memory_forget` | 删除记忆（按 ID 精确删除或按类别+时间批量删除） |

**自动注入：** 会话前 2 轮自动注入 Top-5 高价值记忆到 LLM 上下文（`display: false`，对用户不可见）。第 3 轮起不自动注入，模型按需调用 `memory_search`。

**文件位置：** `memory/entries.json`（1 MB 上限）

**数据流：**
```
web-toolkit 搜到信息 → memory_store 固化 → before_agent_start 自动注入 → 跨会话复用
subagent 学到新知 → memory_store 回写 → 主代理 / 其他子代理 memory_search 检索
```

**清理：** `/memory:prune` 删除低置信度 + 长期未访问条目。

**安装：** 零外部依赖，注册到 `settings.json` 后即生效。无需额外安装步骤。

## 子代理（subagent）

`subagent` 扩展提供将任务委托给专门 agent 的能力，每个子代理运行在独立 `pi` 进程中，拥有隔离的上下文窗口。

### Agent 定义

| Agent | 工具 | 用途 |
|-------|------|------|
| `scout` | read, grep, find, ls, bash | 快速代码探测，返回压缩后的上下文摘要 |
| `planner` | read, grep, find, ls | 根据上下文生成实现计划 |
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

### 工作流 Prompt

通过 `/implement <query>`、`/scout-and-plan <query>`、`/implement-and-review <query>` 快速启动预定义 chain 流程。

### 为什么子代理能省钱

子代理使用独立上下文窗口，主 agent 只需消费压缩后的摘要而非原始文件。在需要探索多个文件或执行独立任务时，隔离上下文避免了主 context 膨胀，变相降低 token 消耗。

### 注意事项

- 所有 agent 默认使用 `settings.json` 中配置的主模型，无需单独指定
- 并行模式默认串行执行（`MAX_CONCURRENCY=1`），避免多进程竞争 GPU 内存。如需并行，修改 `agent/extensions/subagent/index.ts` 中的 `MAX_CONCURRENCY`

## 主动路由（pi-router）

`pi-router` 通过 `before_agent_start` 事件，在每轮 LLM 调用前自动注入两段内容到 system prompt：

### 主动路由策略表

告诉模型何时使用子代理、何时并行、何时 chain，包含具体决策启发式规则（"如果 context > 70% 就 delegate"）。

### 实时 Token 预算

```
[Context: 45,000 / 128,000 tokens (35%). ~83,000 tokens remain.]
```

模型看到实时占用率后，会更主动选择 delegate 到子代理来节省主 context 空间。

**依赖：** 需要 `subagent` 扩展和 agent 定义配合。

## 上下文优化（pi-context-efficiency）

全程零用户感知的 token 节省层。注册 4 个事件处理器 + 1 个命令：

| # | Hook | 作用 | 节省量 |
|---|------|------|--------|
| R2 | `context` | compaction summary 去重，只留最新一份 | 500-1500 tokens/turn |
| R3 | `context` | 旧 turn（>2 轮）的 thinking 块剪枝 | 10-50% 旧 assistant 消息 |
| R4 | `tool_result` | bash/read 输出 >5000 字符时截断 | 50-80% 工具结果 |
| R6 | 命令 | `/ping` 免 LLM 响应 | 单次完全省掉 |

R3 负责 thinking 剪枝（保留最近 2 轮供推理）。R4 仅当输出 >5000 字符时生效：bash 用 `truncateTail`（保留末尾结果）、read 用 `truncateHead`（保留开头）。

### 长任务会话拆分

单次会话跨长时间（如数小时、数十轮工具循环）会把上下文累积到数万 token，每次请求都全量重发历史，是 token 消耗的最大来源。建议：

- **按阶段拆会话**：一个会话聚焦一个阶段任务（侦察/规划/实现/验证），完成后新开会话继续，避免单会话无限累积。
- **提前压缩**：长会话中当上下文接近窗口（compaction 触发线 = 窗口 − `compaction.reserveTokens`，默认配置已调至 32768）时，主动 `/compact` 压缩历史。
- **批量执行**：引导 agent 合并多次 bash 为单次调用，减少固化进历史的碎工具调用（见 APPEND_SYSTEM.md）。

## Wrapper 生命周期

`pi-wrapper.sh` 是进程外生命周期管理器，确保 Pi 在崩溃后自动重启：

```
pi（bash wrapper）→ pi-wrapper.sh → node cli.js
```

- **`pi-wrapper.sh`** — 检测目标 `cli.js`（优先通过 `pi-original` 符号链接，兜底硬编码路径），以 `node cli.js` 方式启动 Pi。注入 `PI_AUTOPILOT=1` 环境变量；崩溃（非 0 退出）累计计数，连续 3 次自动回滚至 lastGood 模型并重启；正常退出记录 lastGood 快照并清零计数；5 分钟内仅回滚一次防死循环。
- **`install-wrapper.sh`** — 安装/卸载 wrapper。安装时把原 `pi` 命令重命名为 `pi-original`，将 wrapper 脚本放置为 `pi`。
- **`pi-orig.sh`** — 绕过 wrapper 直接启动（故障逃生口）。
- **`.bash_aliases`** — 提供 `pic`（继续会话）、`pir`（重启会话）、`piorg`（直启）三个便捷别名。

**安装：** `bash scripts/install-wrapper.sh`

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
| `agent/npm/node_modules/` | ~153 MB | `npm install` | `scripts/rebuild.sh` 自动安装 |
| `agent/extensions/*/node_modules/` | ~104 MB | `npm install` | `scripts/rebuild.sh` 自动安装 |

### 首次使用

```bash
git clone https://github.com/cyfxxx/pi-tools.git ~/.pi
cd ~/.pi && bash scripts/rebuild.sh --yes
bash scripts/install-wrapper.sh   # 可选：安装自动重启 wrapper
```

`rebuild.sh` 会自动完成全部依赖重建（系统工具安装、npm install、venv 创建、二进制下载等）。

## 恢复清单

克隆后首次恢复，建议按以下顺序检查：

### 前置条件

| 检查项 | 要求 | 验证命令 |
|--------|------|---------|
| Node.js | >= 20 | `node -v` |
| npm | 随 Node 自带 | `npm -v` |
| python3 + venv | >= 3.10 | `python3 --version && python3 -m venv --help >/dev/null && echo ok` |
| git | 任意版本 | `git --version` |
| ca-certificates | 已安装（脚本会自动补装） | `dpkg -l ca-certificates` |
| 磁盘空间 | >= 2GB 可用 | `df -h .` |

### 首次恢复步骤

```bash
git clone https://github.com/cyfxxx/pi-tools.git ~/.pi
cd ~/.pi && bash scripts/rebuild.sh --yes
```

### 重建后验证

```bash
# 配置校验
python3 -c "import json; json.load(open('agent/settings.json'))" && echo "settings.json OK"
python3 -c "import yaml; yaml.safe_load(open('searxng/settings.yml'))" && echo "settings.yml OK"

# 核心依赖
ls agent/bin/fd agent/bin/rg && echo "binaries OK"
ls agent/extensions/pi-web-toolkit/node_modules/ | wc -l

# SearXNG
ls searxng/venv/bin/python && echo "venv OK"
ls searxng/repo/.git && echo "repo OK"

# 定时任务
ls agent/extensions/pi-autopilot/node_modules/ | wc -l
crontab -l | grep pi-cron && echo "crontab OK"

# 持久记忆
ls memory/entries.json && echo "memory OK"

```

## 常见问题

### SearXNG 启动后搜索引擎全部超时

**原因：** 国内 DNS 干扰导致 Google/DuckDuckGo 等站点不可达。

**解决：**
- 重新生成配置：`cd searxng && bash generate-config.sh --force`（自动重启运行中的 SearXNG）
- 默认仅启用 baidu、bing、sogou、360search、bilibili、yandex、stackoverflow、github，其余引擎 `disabled: true`
- 如需启用其他引擎，编辑 `searxng/settings.yml`，将对应引擎的 `disabled` 改为 `false`

### Venv 创建后缺少 pip

**原因：** 系统中未安装 `python3-venv` 包，`python3 -m venv` 创建了空壳。

**解决：** 安装后重新创建：
```bash
apt-get install -y python3-venv
rm -rf ~/.pi/searxng/venv
bash ~/.pi/scripts/rebuild.sh --yes
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
npx cloakbrowser install          # 安装 chromium
apt-get install -y libnspr4 libnss3 libatk1.0-0t64 libcups2t64 libgbm1
```


