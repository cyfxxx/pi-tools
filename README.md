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
│   │   ├── ctx-lite/          轻量上下文笔记
│   │   ├── plan-mode/         计划模式
│   │   └── subagent/          子代理
│   ├── skills/                自定义技能
│   │   ├── pi-translate-zh/   中文翻译
│   │   └── pi-backup/         备份恢复技能（本地归档 + GitHub 同步）
│   └── npm/
│       ├── package.json       npm 包声明
│       └── .gitignore         只排除 node_modules/ 和 package-lock.json
├── ctx-lite/                  ctx-lite 运行时数据（checkpoints）
│   └── checkpoints/           笔记检查点
├── searxng/                   SearXNG 自托管搜索引擎
│   ├── settings.yml           SearXNG 配置（含 secret_key）
│   ├── generate-config.sh     settings.yml 自动生成脚本
│   ├── start.sh               启动脚本
│   └── stop.sh                停止脚本
├── scripts/
│   └── rebuild.sh             一键重建脚本（幂等、并行下载、国内镜像加速）
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

支持自动下载/重建：npm 依赖、扩展依赖、fd/rg 二进制、SearXNG venv、SearXNG 源码。

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

```

## 常见问题

### SearXNG 启动后搜索引擎全部超时

**原因：** 国内 DNS 干扰导致 Google/DuckDuckGo 等站点不可达；`extra_proxy_timeout` 配置为 float 类型导致 schema 校验失败。

**解决：**
- 重新生成配置：`cd searxng && bash generate-config.sh --force`
- 默认仅启用 bing 和 baidu，其余引擎 `disabled: true`（已在 `generate-config.sh` 中预设）
- 如需启用其他引擎，编辑 `searxng/settings.yml`，将对应引擎的 `disabled` 改为 `false`

### Venv 创建后缺少 pip

**原因：** 系统中未安装 `python3-venv` 包，`python3 -m venv` 创建了空壳。

**解决：** 安装后重新创建：
```bash
apt-get install -y python3-venv
rm -rf ~/.pi/searxng/venv
bash ~/.pi/scripts/rebuild.sh --yes
```

### Chromium/CloakBrowser 浏览器无法启动

**原因：** Chromium 未安装或缺少系统依赖。

**解决：** rebuild.sh 不包含浏览器安装，手动执行：
```bash
npx cloakbrowser install          # 安装 chromium
apt-get install -y libnspr4 libnss3 libatk1.0-0t64 libcups2t64 libgbm1
```


