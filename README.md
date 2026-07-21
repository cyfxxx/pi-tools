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
│   │   ├── pi-scheduler/      定时任务（interval / cron / once + 离线唤醒）
│   │   ├── ctx-lite/          轻量上下文笔记
│   │   ├── plan-mode/         计划模式
│   │   ├── pi-memory/         跨会话持久记忆
│   │   └── subagent/          子代理
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
│   └── install-systemd.sh     安装 systemd timer（备选）
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

## 定时任务（pi-scheduler）

`pi-scheduler` 扩展提供定时任务能力，支持三种触发方式：

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
ls agent/extensions/pi-scheduler/node_modules/ | wc -l
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


