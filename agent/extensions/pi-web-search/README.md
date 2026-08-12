# Pi Web Search

为 [Pi](https://pi.dev) 编写的网络搜索扩展，集成 **SearXNG** 私密搜索与轻量 HTTP 抓取，让 Pi 的 LLM 获得完整的三级搜索通路。

> 本扩展由原 **pi-web-toolkit** 拆分而来，专注搜索与 HTTP 抓取。浏览器操作（8 个 `browser_*` 工具）请使用 **pi-browser** 扩展。

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Pi (AI 编码代理 CLI)                                                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  pi-web-search (Pi Extension, TypeScript)                      │  │
│  │                                                                 │  │
│  │  fetch_url()     ──── 纯 HTTP GET（15s 超时）                   │  │
│  │  web_fetch()     ──── Bing HTML 解析（无 SearXNG 依赖）         │  │
│  │  web_search()    ──── HTTP JSON API ─────── SearXNG             │
  │                     └─ 多引擎结果 URL 去重（W1，2026-08）       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## 结果处理（W1，2026-08）

多引擎搜索结果按 **URL 去重**：同一链接在多个引擎重复命中时只输出一次，engine 标签合并（如 `[google,bing]`）——避免同一结果重复占用 token 与注意力（借鉴 gpt-researcher `_search_all_retrievers`）。

## 上游项目

| 项目 | 仓库 | 许可证 | 在本扩展中的角色 |
|------|------|--------|----------------|
| **SearXNG** | https://github.com/searxng/searxng | AGPL-3.0 | 隐私友好的元搜索引擎，聚合 Google/Bing/DuckDuckGo/Brave 等 150+ 引擎结果 |
| **Pi** | https://pi.dev | MIT | 宿主平台，TypeScript 扩展系统 |

### 不修改源码的保证

| 项目 | 集成方式 | 更新方法 |
|------|---------|---------|
| SearXNG | 纯 HTTP fetch 调用 `?format=json` API，零代码依赖 | 更新 SearXNG 服务端即可 |

## 本地 SearXNG 部署

本地部署 SearXNG 可提供更快的搜索速度、完全的数据隐私、不受公共实例可用性影响。

### 一键部署

```bash
# 运行扩展目录中的安装脚本（包含 SearXNG 部署选项）
bash ~/.pi/agent/extensions/pi-web-search/install.sh
```

脚本会自动完成：系统依赖 → 克隆仓库 → 创建 venv → 安装 SearXNG → 生成配置 → 启动并验证。

### 手动部署

```bash
# 1. 安装系统依赖
sudo apt install -y python3-dev python3-venv python3-pip git build-essential \
  libxslt-dev zlib1g-dev libffi-dev libssl-dev

# 2. 克隆 SearXNG 仓库
mkdir -p ~/.pi/searxng
git clone --depth 1 https://github.com/searxng/searxng.git ~/.pi/searxng/repo

# 3. 创建虚拟环境并安装
python3 -m venv ~/.pi/searxng/venv
source ~/.pi/searxng/venv/bin/activate
pip install -U pip setuptools wheel pyyaml msgspec typing-extensions
pip install --use-pep517 --no-build-isolation -e ~/.pi/searxng/repo
pip install granian
deactivate

# 4. 生成配置并设置密钥
python3 -c "import secrets; print(secrets.token_hex(32))"  # 复制输出的密钥
cat > ~/.pi/searxng/settings.yml << 'EOF'
use_default_settings: true
server:
  port: 8889
  bind_address: "127.0.0.1"
  secret_key: "上面生成的密钥"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
EOF

# 5. 启动服务
SEARXNG_SETTINGS_PATH=~/.pi/searxng/settings.yml \
  ~/.pi/searxng/venv/bin/granian searx.webapp:app \
  --interface wsgi --host 127.0.0.1 --port 8889 --workers 2

# 6. 验证服务
curl 'http://127.0.0.1:8889/search?format=json&q=hello'
```

> **⚠️ Termux/PRoot 混合环境注意事项**
>
> 在 Android 上通过 Termux + PRoot 运行的 Linux 环境中，Python 的 C 扩展编译和加载存在兼容性问题。
>
> **Python 版本选择：**
> 必须使用 **Python 3.12**（而非 3.13）。Python 3.13 下 `msgspec` 和 `lxml` 的 `.so` 文件会因 Android 命名空间隔离而加载失败：
> ```
> ImportError: dlopen failed: library ".../msgspec/_core.cpython-313.so"
> is not accessible for the namespace "(default)"
> ```
> Python 3.12 有预编译 wheel 包，可避免从源码编译 C 扩展。
>
> **修改后的部署步骤：**
>
> ```bash
> # 1. 安装系统依赖（注意包名差异）
> sudo apt install -y python3.12-venv python3.12-pip git \
>   libxml2-dev libxslt1-dev
>
> # 2. 创建虚拟环境（使用 python3.12 而非 python3）
> python3.12 -m venv ~/.pi/searxng/venv
> source ~/.pi/searxng/venv/bin/activate
>
> # 3. 安装 SearXNG（无需 --use-pep517 --no-build-isolation）
> pip install -U pip setuptools wheel pyyaml msgspec typing-extensions
> pip install ~/.pi/searxng/repo
> pip install granian
> deactivate
>
> # 4. 后续步骤（生成配置、启动、验证）与正常流程相同
> ```
>
> **apt 安装 python3-lxml 也生效**（无需 pip 编译）：
> ```bash
> sudo apt install -y python3-lxml
> ```
>
> 其他环境（标准 Linux/macOS/WSL）请使用上方「手动部署」中的标准步骤。

### 管理命令

```bash
# 启动（使用封装脚本）
bash ~/.pi/agent/extensions/pi-web-search/start-searxng.sh

# 停止
bash ~/.pi/searxng/stop.sh

# 查看日志
tail -f ~/.pi/searxng/searxng.log

# 更新 SearXNG
cd ~/.pi/searxng/repo && git pull
source ~/.pi/searxng/venv/bin/activate
pip install --use-pep517 --no-build-isolation -e .
deactivate
# 重启服务
bash ~/.pi/searxng/stop.sh && bash ~/.pi/searxng/start.sh
```

### 配置扩展使用本地 SearXNG

部署完成后，编辑 `~/.pi/agent/settings.json`：

```json
{
  "pi-web-search": {
    "searxng_url": "http://127.0.0.1:8889",
    "search_timeout": 10000
  }
}
```

也可通过环境变量配置：`PI_WEB_TOOLKIT_SEARXNG_URL=http://127.0.0.1:8889`

## 目录结构

```
~/.pi/agent/extensions/pi-web-search/
├── index.ts                   # ★ 入口 orchestrator
├── config.ts                  # 配置聚合器：settings.json → 环境变量 → 默认值
├── types.ts                   # SearchOnlyConfig
├── package.json               # npm 包配置，入口 → ./index.ts
├── tsconfig.json
├── install.sh                 # 一键安装脚本（部署扩展 + 可选 SearXNG）
├── start-searxng.sh           # 启动本地 SearXNG 服务
│
├── fetch.ts                   # ⚡ 轻量 HTTP 工具（fetch_url + web_fetch）
│
├── search/                    # 🔍 搜索功能
│   ├── index.ts               #   registerSearchTools()
│   ├── impl.ts                #   searchWeb(), formatResponse()
│   ├── types.ts               #   SearchConfig, SearchResponse, SearchResultItem
│   └── config.ts              #   buildSearchConfig()
│
└── tests/                     # 单元测试 + 跨扩展注册测试

~/.pi/searxng/                 # （可选）本地 SearXNG 部署目录
├── repo/                      # git 克隆的 SearXNG 仓库
├── venv/                      # Python 虚拟环境
├── settings.yml               # SearXNG 配置文件
├── searxng.log                # 运行日志
├── start.sh                   # 启动脚本
└── stop.sh                    # 停止脚本
```

## 配置参考

### settings.json（推荐）

编辑 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）：

```json
{
  "pi-web-search": {
    "searxng_url": "https://your-searxng.tld",
    "search_timeout": 15000
  }
}
```

> **兼容说明：** 配置段缺失时自动回退读取旧版 `pi-web-toolkit` 配置段，升级拆分无需手动迁移。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_WEB_TOOLKIT_SEARXNG_URL` | SearXNG 实例地址 | `https://searx.be` |
| `PI_WEB_TOOLKIT_SEARCH_TIMEOUT` | 搜索超时（毫秒） | `15000` |

### 配置优先级

**settings.json > 环境变量 > 内置默认值**

默认 SearXNG 实例为 `https://searx.be`（公共实例，无需注册即可使用）。

## 部署指南

### 前置条件

- Node.js >= 18
- Pi 已安装并可用（`npm install -g @earendil-works/pi-coding-agent`）

### 安装步骤

#### 方式 A：一键安装（推荐）

```bash
# 运行安装脚本（自动处理一切）
# 可选择是否部署本地 SearXNG
bash ~/.pi/agent/extensions/pi-web-search/install.sh
```

#### 方式 B：手动安装

```bash
# 1. 确保扩展目录存在
mkdir -p ~/.pi/agent/extensions

# 2. 将扩展复制到 Pi 的扩展目录
cp -r pi-web-search ~/.pi/agent/extensions/

# 3. 安装 npm 依赖
cd ~/.pi/agent/extensions/pi-web-search
npm install

# 4. （可选）配置 SearXNG 实例
#    编辑 ~/.pi/agent/settings.json 填入你的 SearXNG 地址

# 5. 验证安装
pi --no-extensions -e ~/.pi/agent/extensions/pi-web-search/index.ts "搜索网络扩展验证"
```

### 验证检查清单

- [ ] `npm install` 成功完成
- [ ] `web_search` 工具能返回搜索结果
- [ ] `fetch_url` 能获取纯文本 URL
- [ ] `web_fetch` 能返回搜索结果（不依赖 SearXNG）

## 工具参考

### fetch_url

轻量 HTTP GET 工具，无需启动浏览器即可获取 URL 内容。适用于纯文本、API 响应、JSON、Markdown 文档。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 完整 URL（须包含协议，如 `https://`） |
| `max_length` | number | 否 | 最大返回字符数，默认 `8000`。超过时自动截断并提示总长度 |

**返回：** URL 内容文本（可能被截断）。

**超时：** 15 秒。超过自动取消。

> **与 browser_navigate 分工（pi-browser 扩展）：**
> - `fetch_url`：纯 HTTP GET，轻量（< 1s），适合 API/文档/纯文本
> - `browser_navigate`：完整浏览器渲染，适合需要 JS 执行的页面

**示例：**
```
→ LLM 调用: fetch_url(url="https://api.example.com/data.json", max_length=2000)
→ 返回:   {"status":"ok","results":[...]}
          ...
          （共 4580 字符，仅显示前 2000 字符）
```

### web_fetch

轻量 HTTP 搜索工具，直接解析 Bing 搜索结果页面 HTML。不依赖 SearXNG 服务，适合搜索服务不可用时的 fallback。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索关键词 |
| `max_results` | number | 否 | 最大返回结果数，默认 `5` |

**返回：** 编号搜索结果列表（标题 + URL）。

**超时：** 10 秒。

> **搜索通路选择：**
> 1. `web_search` (SearXNG) — 首选，隐私保护，结果丰富
> 2. `web_fetch` (Bing 直搜) — 备选，SearXNG 不可用时使用
> 3. `fetch_url` + Bing URL 组合 — 最后的 fallback

**示例：**
```
→ LLM 调用: web_fetch(query="Rust web framework 2026")
→ 返回:  搜索: "Rust web framework 2026"

         1. Top 10 Rust Web Frameworks in 2026
            https://example.com/rust-web-frameworks-2026
         2. Rust Web Framework Benchmarks
            https://example.com/rust-benchmarks
```

### web_search

使用 SearXNG 进行私密网络搜索。支持多引擎组合（如遇 Google 不可用，可切换至 Bing/DuckDuckGo/Brave）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | 是 | 搜索关键词 |
| `engines` | string[] | 否 | 指定引擎列表，如 ["google","bing","duckduckgo"]。留空则使用 SearXNG 默认配置。当网络环境变化时可切换引擎组合。 |
| `categories` | string | 否 | 搜索类别：`general`、`news`、`images`、`videos`、`files`、`map`、`music`、`it`、`science`、`social media` |
| `pageno` | number | 否 | 页码，从 1 开始。用于翻页查看更多结果。 |
| `time_range` | string | 否 | 时间范围：`day`、`week`、`month`、`year` |
| `lang` | string | 否 | 语言代码：`zh-CN`、`en-US`、`ja-JP` |
| `max_results` | number | 否 | 最大返回结果数（默认 `5`）。设为 `1` 只取 top-1，设为 `10` 获取更多结果 |
| `brief` | boolean | 否 | 简洁模式（默认 `false`）。开启后只返回标题 + URL，省略摘要文本，节省 ~60% Token |

**返回：** 结构化搜索结果（标题、链接、摘要、来源引擎），直接答案，搜索建议，拼写纠正，自动标注不可用引擎。

> **💡 引擎可用性说明**
>
> SearXNG 聚合了 150+ 搜索引擎，但实际可用性取决于你的网络环境。
>
> **国内网络环境下推荐优先使用的引擎：**
>
> | 引擎 | 地区 | 可信度 | 说明 |
> |------|------|--------|------|
> | `baidu` | 🇨🇳 | ⭐⭐⭐ | 百度搜索，中文结果最丰富 |
> | `sogou` | 🇨🇳 | ⭐⭐⭐ | 搜狗搜索，中文结果良好 |
> | `360search` | 🇨🇳 | ⭐⭐⭐ | 360 搜索 |
> | `bilibili` | 🇨🇳 | ⭐⭐⭐ | B站内容搜索 |
> | `bing` | 🌐 | ⭐⭐⭐ | 微软必应，已通过 bing.py 修复（跟随重定向） |
> | `yandex` | 🇷🇺 | ⭐⭐ | 俄罗斯 Yandex，可用作备选 |
>
> **在上述环境中不可用的引擎：** `google`、`duckduckgo`、`brave`、`startpage`、`qwant`、`yahoo`、`wikipedia`、`wikidata`（均因网络限制超时）。
>
> **调用示例：**
> ```json
> {
>   "query": "搜索关键词",
>   "engines": ["baidu", "sogou", "bing"],
>   "lang": "zh-CN"
> }
> ```
> 推荐始终指定 `engines` 参数，避免使用默认引擎列表（默认以 Google 为主，国内网络下会全部超时）。
>
> **⚠️ Bing 引擎特别说明**
>
> 国内网络访问 `www.bing.com` 会 302 重定向至 `cn.bing.com`。SearXNG 默认不跟随重定向（`allow_redirects: false`, `max_redirects: 0`），导致 Bing 引擎解析重定向页面（空 HTML）后返回 0 条结果。
>
> **当前状态：已修复 ✅**
>
> 采用方案 B 修复（修改引擎源码 + 增加超时），在 `~/.pi/searxng/venv/lib/python3.12/site-packages/searx/engines/bing.py` 的 `request()` 函数中添加：
> ```python
> params["allow_redirects"] = True
> params["max_redirects"] = 5
> params["soft_max_redirects"] = 5
> ```
> 同时在 `~/.pi/searxng/settings.yml` 中增加超时：
> ```yaml
> outgoing:
>   request_timeout: 10.0
>   max_request_timeout: 30.0
> ```
>
> **注意：** 修改的 bing.py 位于 venv site-packages 内，重新 `pip install` 或升级 SearXNG 后会覆盖，需重新修复。
>
> 备用方案：
>
> **方案 A — 修改 SearXNG 配置：** 在 `~/.pi/searxng/settings.yml` 中添加引擎覆盖：
> ```yaml
>   - name: bing
>     engine: bing
>     base_url: https://cn.bing.com
> ```

**示例：**

```
→ LLM 调用: web_search(query="Rust web framework comparison 2026", engines=["google","bing","duckduckgo"], time_range="month")
→ 返回:   搜索: "Rust web framework comparison 2026"

           找到 15 条结果：

           ### Top 10 Rust Web Frameworks in 2026 [google]
           https://example.com/rust-web-frameworks-2026
           随着 Rust 生态的发展，Actix-web、Axum、Rocket ...

           ### Rust Web Framework Benchmarks [bing]
           https://example.com/rust-benchmarks
           最新性能对比测试显示 Axum 在吞吐量方面领先 ...

           ⚠ 以下引擎无响应：duckduckgo
           可尝试减少 engines 参数或切换 categories。
```

## 使用场景示例

### 场景 1：搜索 + 浏览内容

```
用户: 找一下 Rust 的 web framework 有哪些

→ LLM 调用: web_search(query="Rust web framework comparison 2026")
→ LLM 调用: fetch_url(url="https://www.arewewebyet.org/")
```

### 场景 2：搜索引擎故障切换

```
用户: Google 搜索结果不太行

→ LLM 调用: web_search(query="latest AI papers",
                        engines=["google","bing","brave","duckduckgo","qwant"])
            // 如 Google 不可用，自动返回其他引擎结果
            // 响应中会标注哪些引擎无响应
```

## 故障排查

| 问题 | 原因 | 解决方法 |
|------|------|---------|
| **SearXNG 返回 404** | SearXNG 实例地址错误 | 检查 `searxng_url` 配置，确认 `curl <实例>/search` 返回 200 |
| **SearXNG 连接超时** | 网络问题或 SearXNG 不可达 | 尝试更换为其他公共实例或自部署 SearXNG |
| **所有搜索引擎均无响应** | SearXNG 引擎配置问题 | 检查 `settings.yml` 中引擎配置；尝试切换 `categories` 参数 |
| **Pi 报错"扩展未找到"** | 扩展不在搜索路径 | 确认扩展在 `~/.pi/agent/extensions/` 中；或使用 `-e` 参数指定路径 |
| **npm install 失败** | 网络问题或版本冲突 | 检查 Node.js 版本（>= 18）；尝试 `npm install --legacy-peer-deps` |

## 安全注意事项

- **扩展以用户完整权限运行**：Pi 扩展系统设计如此，无内置沙箱。仅从信任的来源安装扩展。
- **SearXNG 实例信任**：使用公共 SearXNG 实例时，搜索查询会经过第三方服务器。敏感或隐私查询建议自部署 SearXNG。

## Token 效率

pi-web-search 集成了 Token 预算管理模块 (`lib/token-budget.ts`、`lib/prune.ts`)，自动记录每次工具调用的 Token 消耗：

| 工具 | Token 优化 | 预估节省 |
|------|-----------|---------|
| `web_search` | `max_results` 默认 5（原隐性 20），`brief` 模式省略摘要 | ~70% |
| `fetch_url` | `max_length` 默认 8000，无浏览器开销 | ~50% vs browser |
| `web_fetch` | 纯标题+URL，无摘要 | ~80% vs web_search |

每次工具调用结束后自动调用 `recordToolUsage()` 记录工具使用计数（按工具累计 token 估算，仅供诊断统计，不注入 LLM 上下文）。上下文压力提示由 pi-context 扩展统一承担，本扩展不注入。
