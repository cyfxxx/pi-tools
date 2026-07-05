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
│   │   └── TOKEN-BUDGET.md    使用文档
│   ├── extensions/            自定义扩展
│   │   ├── pi-web-toolkit/    浏览器自动化 + 搜索 + 代理池
│   │   ├── ctx-lite/          轻量上下文笔记
│   │   ├── plan-mode/         计划模式
│   │   └── subagent/          子代理
│   ├── skills/                自定义技能
│   │   ├── pi-translate-zh/   中文翻译
│   │   └── pi-backup/         备份恢复技能（本地归档 + GitHub 同步）
│   └── npm/
│       ├── package.json       npm 包声明
│       └── .gitignore         只排除 node_modules/ 和 package-lock.json
├── searxng/                   SearXNG 自托管搜索引擎
│   ├── proxy_list.txt         代理 IP 池
│   ├── settings.yml           SearXNG 配置（含 secret_key）
│   ├── generate-config.sh     settings.yml 自动生成脚本
│   ├── start.sh               启动脚本
│   └── stop.sh                停止脚本
├── scripts/
│   └── rebuild.sh             一键重建脚本（幂等、并行下载、国内镜像加速）
├── sing-box/                  Sing-box 代理核心
│   └── sing-box               ~62MB 二进制（git 不追踪）
├── test_proxies.py            代理连通性测试
├── test_global_proxies.py     全局代理测试
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
- **并发下载** — sing-box 等多组件同时下载
- **自动补全配置** — 自动生成 `searxng/settings.yml`、`agent/npm/package.json`（如缺失）
- **格式校验** — 重建后自动验证 YAML/JSON 配置文件

支持自动下载/重建：npm 依赖、扩展依赖、fd/rg 二进制、SearXNG venv、SearXNG 源码、sing-box。

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
| `sing-box/sing-box` | ~62 MB | GitHub Releases | `scripts/rebuild.sh` 自动下载 |
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
