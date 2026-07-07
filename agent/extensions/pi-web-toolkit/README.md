# Pi Web Toolkit

为 [Pi](https://pi.dev) 编写的网络功能扩展，集成 **SearXNG** 私密搜索、**CloakBrowser** 隐身浏览器、**browser-harness** 交互模式，让 Pi 的 LLM 获得完整的网络访问能力。

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Pi (AI 编码代理 CLI)                                                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  pi-web-toolkit (Pi Extension, TypeScript)                     │  │
│  │                                                                 │  │
│  │  fetch_url()     ──── 纯 HTTP GET（15s 超时）                   │  │
│  │  web_fetch()     ──── Bing HTML 解析（无 SearXNG 依赖）         │  │
│  │  web_search()    ──── HTTP JSON API ─────── SearXNG             │  │
│  │  browser_navigate() ──┐                                         │  │
│  │  browser_screenshot()  ├── CDP Protocol ──── CloakBrowser       │  │
│  │  browser_click()       │   (定制 Chromium)                      │  │
│  │  browser_type()       ─┘    │                                   │  │
│  │  browser_scroll()            │  系统代理 env vars (由 ProxyPool 管理)│  │
│  │  browser_extract()  ──── CDP Runtime.evaluate                   │  │
│  │  browser_evaluate() ──── CDP Runtime.evaluate                   │  │
│  │  browser_close()    ──── 生命周期管理                           │  │
│  │  proxy_status() ────────────┐                                   │  │
│  │  proxy_add()          ──────┤                                   │  │
│  │  proxy_rotate()       ──────┤── ProxyPool ──→ 系统代理          │  │
│  │  proxy_on()           ──────┤       └── sing-box 子进程          │  │
│  │  proxy_off()          ──────┤         + Clash API 兼容层         │  │
│  │  proxy_set()          ──────┘   HTTP_PROXY/HTTPS_PROXY env vars │  │
│  │                                                                 │  │
│  │  交互模式参考: browser-harness (坐标点击 + 截图驱动)            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## 上游项目

| 项目 | 仓库 | 许可证 | 在本扩展中的角色 |
|------|------|--------|----------------|
| **SearXNG** | https://github.com/searxng/searxng | AGPL-3.0 | 隐私友好的元搜索引擎，聚合 Google/Bing/DuckDuckGo/Brave 等 150+ 引擎结果 |
| **CloakBrowser** | https://github.com/CloakHQ/CloakBrowser | MIT (封装器) + 自定义二进制 (Chromium) | 58 处 C++ 源码级隐身补丁的 Chromium，绕过反爬虫检测 |
| **browser-harness** | https://github.com/browser-use/browser-harness | MIT | 截图驱动 + 坐标点击的交互模式参考，穿透 iframe/Shadow DOM |
| **Pi** | https://pi.dev | MIT | 宿主平台，TypeScript 扩展系统 |
### 不修改源码的保证

| 项目 | 集成方式 | 更新方法 |
|------|---------|---------|
| SearXNG | 纯 HTTP fetch 调用 `?format=json` API，零代码依赖 | 更新 SearXNG 服务端即可 |
| CloakBrowser | npm 包 `cloakbrowser` 直接 `import { launch }` | `npm update cloakbrowser` |
| browser-harness | 仅参考设计模式，纯 TypeScript 自实现 | 无需更新（非直接依赖） |
## 本地 SearXNG 部署

本地部署 SearXNG 可提供更快的搜索速度、完全的数据隐私、不受公共实例可用性影响。

### 一键部署

```bash
# 运行扩展目录中的安装脚本（包含 SearXNG 部署选项）
bash ~/.pi/agent/extensions/pi-web-toolkit/install.sh
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
bash ~/.pi/agent/extensions/pi-web-toolkit/start-searxng.sh

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
  "extensions": {
    "pi-web-toolkit": {
      "searxng_url": "http://127.0.0.1:8889",
      "search_timeout": 10000
    }
  }
}
```

也可通过环境变量配置：`PI_WEB_TOOLKIT_SEARXNG_URL=http://127.0.0.1:8889`

## 目录结构

```
~/.pi/agent/extensions/pi-web-toolkit/
├── index.ts                   # ★ 入口 orchestrator（~30 行）
├── config.ts                  # 配置聚合器：settings.json → 环境变量 → 默认值
├── types.ts                   # 跨功能类型：WebToolkitConfig
├── env.d.ts                   # Pi ExtensionAPI 类型声明
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
├── browser/                   # 🌐 浏览器功能
│   ├── index.ts               #   registerBrowserTools()
│   ├── impl.ts                #   BrowserManager 类
│   ├── types.ts               #   BrowserConfig, PageInfo
│   └── config.ts              #   buildBrowserConfig()
│
├── proxy/                     # 🔌 代理控制
│   ├── index.ts               #   registerProxyControlTools()
│   ├── pool.ts                #   ProxyPool 类
│   ├── sing-box.ts            #   SingBoxManager 类
│   ├── subscription.ts        #   代理订阅解析 (VLESS/VMess/Trojan/SS/Hy2)
│   ├── types.ts               #   ProxyPoolConfig, PoolStats, ParsedProxy
│   └── config.ts              #   buildProxyPoolConfig()
│
├── scripts/
│   ├── test-proxies.py        # 代理发现工具（HTTP/HTTPS/SOCKS 测试）
│   └── test-global-proxies.py # 全局代理测试（多源 + Google 可达性）
│
└── tests/
    ├── browser.test.ts        # BrowserManager 单元测试
    ├── config.test.ts         # 配置加载测试
    ├── index.test.ts          # 入口工具注册测试
    ├── proxy-control.test.ts  # 代理控制工具测试
    ├── search.test.ts         # 搜索功能测试
    └── subscription.test.ts   # 代理订阅解析测试

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
  "extensions": {
    "pi-web-toolkit": {
      "searxng_url": "https://your-searxng.tld",
      "search_timeout": 15000,
      "headless": false,
      "viewport_width": 1280,
      "viewport_height": 800,
      "fingerprint_seed": "my-fingerprint",
      "proxy": "http://127.0.0.1:8080",
      "data_dir": "~/.pi-web-toolkit/profile",
      "proxy_pool": {
        "enabled": true,
        "strategy": "round-robin",
        "health_check_interval": 300,
        "subscription_urls": [
          "https://raw.githubusercontent.com/example/v2ray/main/v.txt"
        ],
        "proxies": [
          "http://1.2.3.4:8080"
        ],
        "fallback_direct": true
      }
    }
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_WEB_TOOLKIT_SEARXNG_URL` | SearXNG 实例地址 | `https://searx.be` |
| `PI_WEB_TOOLKIT_SEARCH_TIMEOUT` | 搜索超时（毫秒） | `15000` |
| `PI_WEB_TOOLKIT_HEADLESS` | 无头模式 | `false` |
| `PI_WEB_TOOLKIT_VIEWPORT_WIDTH` | 浏览器视口宽度 | `1280` |
| `PI_WEB_TOOLKIT_VIEWPORT_HEIGHT` | 浏览器视口高度 | `800` |
| `PI_WEB_TOOLKIT_FINGERPRINT_SEED` | 浏览器指纹种子 | （随机） |
| `PI_WEB_TOOLKIT_PROXY` | 代理地址 | （无） |
| `PI_WEB_TOOLKIT_PROXY_POOL_ENABLED` | 启用代理池 | `false` |
| `PI_WEB_TOOLKIT_PROXY_POOL_STRATEGY` | 选择策略（random/round-robin/latency） | `round-robin` |
| `PI_WEB_TOOLKIT_PROXY_POOL_HEALTH_CHECK_INTERVAL` | 健康检查间隔（秒） | `300` |

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
bash ~/.pi/agent/extensions/pi-web-toolkit/install.sh
```

#### 方式 B：手动安装

```bash
# 1. 确保扩展目录存在
mkdir -p ~/.pi/agent/extensions

# 2. 将扩展复制到 Pi 的扩展目录
cp -r pi-web-toolkit ~/.pi/agent/extensions/

# 3. 安装 npm 依赖
cd ~/.pi/agent/extensions/pi-web-toolkit
npm install

# 4. （可选）配置 SearXNG 实例
#    编辑 ~/.pi/agent/settings.json 填入你的 SearXNG 地址

# 5. 验证安装
pi --no-extensions -e ~/.pi/agent/extensions/pi-web-toolkit/index.ts "搜索网络扩展验证"
```

### 验证检查清单

- [ ] `npm install` 成功完成
- [ ] CloakBrowser 首次启动自动下载隐身 Chromium（约 200MB，存放在 `~/.cloakbrowser/`）
- [ ] `web_search` 工具能返回搜索结果（首次使用会自动安装 CloakBrowser 二进制文件）
- [ ] `browser_navigate` 能成功打开网页
- [ ] `fetch_url` 能获取纯文本 URL（不需要浏览器）
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

> **与 browser_navigate 分工：**
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
>
> **方案 C — 通过代理：** 需**付费境外代理**，免费代理无一支持 HTTPS CONNECT（下文详述）。

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

### proxy_status / proxy_add / proxy_rotate / proxy_on / proxy_off / proxy_set

代理控制系统（仅在配置了 `proxy_pool` 时注册）。

**原理：** ProxyPool 从订阅 URL 拉取或手动添加代理，由 sing-box 子进程管理。启用系统代理后，`HTTP_PROXY`/`HTTPS_PROXY` 环境变量自动指向 sing-box 的本地混合代理端口，当前进程及所有子进程的网络流量均通过代理发出。

**配置：** 在 `settings.json` 的 `extensions.pi-web-toolkit` 中添加 `proxy_pool` 字段：

```json
{
  "proxy_pool": {
    "subscription_urls": [
      "https://raw.githubusercontent.com/example/v2ray/main/v.txt"
    ],
    "strategy": "round-robin",
    "health_check_url": "http://httpbin.org/ip",
    "health_check_interval": 300,
    "fallback_direct": true
  }
}
```

**工具列表：**

| 工具 | 说明 |
|------|------|
| `proxy_status` | 查看代理总数、存活/失效数量、平均延迟、系统代理开关状态及各代理详情 |
| `proxy_add` | 手动向池中添加一批代理（传入数组，支持 HTTP/HTTPS/SOCKS） |
| `proxy_rotate` | 强制轮转当前代理 |
| `proxy_on` | 启用系统代理，设置 HTTP_PROXY/HTTPS_PROXY 环境变量，所有子进程网络走代理 |
| `proxy_off` | 禁用系统代理，清空环境变量并停止 sing-box |
| `proxy_set` | 添加一个代理并立即启用为系统代理（一键操作） |

> **⚠️ 当前状态：** 已测试多个免费代理源，结论——免费代理无法用于绕过 GFW 访问境外搜索引擎。
>
> **测试结果（4021+2521 个代理）：**
>
> | 源 | 代理数 | HTTP 存活 | HTTPS 支持 | Google 可达 |
> |-----|-------|----------|-----------|------------|
> | proxifly (中+外) | 3673 | 204 (5.6%) | 85 (2.3%) | 0 |
> | proxifly (仅境外) | 2091 | 2 (0.1%) | 0 | 0 |
> | geonode | 400 | 0 | 0 | 0 |
> | freevpnnode | 30 | 1 (3.3%) | 0 | 0 |
>
> 测试的 6194 个免费代理中，无一能访问 Google 等被屏蔽站点。存活代理或位于国内（无法出境），或仅支持 HTTP（不支持 CONNECT 隧道且极不稳定）。
>
> **建议：**
> - 方案一：`proxies: ["http://user:pass@your-proxy:8080"]` 填写**付费境外代理**
> - 方案二：`proxy_source_url` 指向自建代理 API（如 jhao104/proxy_pool 服务）
> - 方案三：不使用代理，仅用国内可达引擎（baidu/sogou/bing/yandex）

### browser_navigate

使用 CloakBrowser 隐身浏览器打开 URL。自动绕过 Cloudflare Turnstile、reCAPTCHA v3 等多层反爬虫检测。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 完整 URL（须包含协议，如 `https://`） |
| `extract_text` | "summary" / "full" / "none" | 否 | 文本提取模式（默认 `"summary"`）。`summary` 返回结构化摘要（标题 + 要点），`full` 返回完整可见文本，`none` 跳过提取 |

**返回：** 页面标题、URL、视口大小、可见文本内容（summary 模式下为结构化摘要）。

### browser_screenshot

截取当前页面截图。截图保存到 `/tmp/`，返回文件路径。LLM 可分析截图后通过 `browser_click` 的坐标模式进行精准点击（参考 browser-harness 截图驱动交互模式）。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `full_page` | boolean | 否 | 是否截取整个页面（包含滚动区域外的内容，默认 `false`） |

**返回：** 截图文件路径。

### browser_click

两种模式可选：

1. **坐标模式**（推荐）：提供 `x`、`y` 像素坐标。该模式穿透 iframe/Shadow DOM/跨域框架，在浏览器组合器层执行，推荐配合截图使用。
2. **选择器模式**：提供 CSS 选择器，精准定位元素。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `x` | number | 否 | X 坐标（与 `y` 同时提供时启用坐标模式） |
| `y` | number | 否 | Y 坐标 |
| `selector` | string | 否 | CSS 选择器，如 `"button#submit"`、`".search-btn"`、`"a[href*='login']"` |
| `button` | string | 否 | 鼠标按键：`left`、`right`、`middle`（默认 `left`） |

**坐标模式示例：**

```
→ 用户: 点击搜索按钮
→ LLM: 先调用 browser_screenshot()
→ LLM: 分析截图，估算搜索按钮的坐标位置
→ LLM: 调用 browser_click(x=420, y=580)
```

### browser_type

在页面中输入文本。可通过 CSS 选择器指定目标输入框，或输入到当前焦点元素。推荐先点击目标输入框（使用 `browser_click`），再调用本工具。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 要输入的文本内容 |
| `selector` | string | 否 | CSS 选择器，如 `"#search"`、`"input[name='q']"`。留空则在当前焦点元素输入。 |

### browser_scroll

滚动当前页面。默认向下滚动约 80% 视口高度。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `direction` | string | 否 | 滚动方向：`down`、`up`（默认 `down`） |
| `amount` | number | 否 | 滚动像素数。为空则滚动一个视口高度。 |

### browser_extract

提取当前页面的可见文本。可通过 CSS 选择器提取页面特定区域的内容，留空则提取整个页面。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `selector` | string | 否 | CSS 选择器，如 `"article"`、`".main-content"`。留空提取整页。 |

### browser_evaluate

在页面中执行任意 JavaScript 代码，返回序列化结果。用于高级 DOM 操作、数据提取、页面状态检查等。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `script` | string | 是 | 要执行的 JavaScript 代码。返回值会被序列化为 JSON。 |

**示例：**

```javascript
// 提取所有链接
document.querySelectorAll('a').map(a => ({href: a.href, text: a.textContent}))

// 获取页面元数据
JSON.stringify({title: document.title, url: location.href})
```

### browser_close

关闭当前浏览器实例，释放系统资源。在不再需要浏览器操作时调用。

**参数：** 无。

### proxy_status

查看代理控制系统的当前状态，包括池代理总数、存活数、失效数、平均延迟、系统代理开关状态，以及每个代理的详情。

**参数：** 无。

**返回：** 代理状态摘要 + 各代理详情列表。

### proxy_add

运行时批量添加代理到代理池。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxies` | string[] | 是 | 代理地址数组，如 `["http://user:pass@1.2.3.4:8080", "socks5://5.6.7.8:1080"]` |

**返回：** 新增数量 + 更新后池状态。

### proxy_rotate

强制将当前代理切换到池中的下一个可用代理。如果系统代理已启用，环境变量将立即指向新代理。

**参数：** 无。

**返回：** 新代理地址。

### proxy_on

启用系统级代理。自动启动 sing-box（如未运行），设置 `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` 环境变量指向代理地址。当前进程及所有子进程的网络流量将通过代理发出。

**参数：** 无。

**返回：** 系统代理已启用 + 代理地址。

### proxy_off

禁用系统级代理。清空 `HTTP_PROXY`/`HTTPS_PROXY` 等环境变量并停止 sing-box 子进程。

**参数：** 无。

**返回：** 系统代理已禁用。

### proxy_set

一键操作：添加一个代理地址到池 → 自动选中 → 启用系统代理。等价于 `proxy_add` + `proxy_rotate` + `proxy_on`。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `proxy` | string | 是 | 代理 URL，如 `"http://user:pass@1.2.3.4:8080"` |

**返回：** 已添加并启用 + 当前代理地址。

## 使用场景示例

### 场景 1：搜索 + 浏览内容

```
用户: 找一下 Rust 的 web framework 有哪些

→ LLM 调用: web_search(query="Rust web framework comparison 2026")
→ LLM 调用: browser_navigate(url="https://www.arewewebyet.org/")
```

### 场景 2：协作式页面交互

```
用户: 帮我搜索 GitHub 上 star 最多的 Rust 项目

→ LLM 调用: browser_navigate(url="https://github.com/topics/rust?o=desc&s=stars")
→ LLM 调用: browser_screenshot()
→ LLM 分析截图，定位项目列表区域
→ LLM 调用: browser_extract(selector=".repo-list li h3")
```

### 场景 3：绕过反爬虫抓取

```
用户: 访问这个有验证保护的网站

→ LLM 调用: browser_navigate(url="https://example-protected.com")
            // CloakBrowser 自动处理 Cloudflare Turnstile / reCAPTCHA
→ LLM 调用: browser_screenshot()
→ LLM 调用: browser_click(x=500, y=300)
```

### 场景 4：搜索引擎故障切换

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
| **CloakBrowser 下载失败** | 网络问题或磁盘空间不足 | 检查网络连接，确保 `~/.cloakbrowser/` 所在分区有 500MB+ 空间 |
| **CloakBrowser 无法启动** | 系统缺少依赖（Linux） | 安装：`apt install libnss3 libatk1.0-0 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 libgbm1 libpango-1.0-0 libcairo2` |
| **截图全黑/空白** | headless 模式无 GPU 渲染 | 设置 `headless: false`，或使用 Xvfb：`xvfb-run pi ...` |
| **坐标点击无响应** | 页面未完全加载 | 确认页面已加载完成；尝试先调用 `browser_screenshot` 确认页面状态 |
| **元素点击无响应** | 元素被遮挡或不在视口内 | 使用坐标模式点击；或先调用 `browser_scroll` 滚动到目标位置 |
| **Pi 报错"扩展未找到"** | 扩展不在搜索路径 | 确认扩展在 `~/.pi/agent/extensions/` 中；或使用 `-e` 参数指定路径 |
| **npm install 失败** | 网络问题或版本冲突 | 检查 Node.js 版本（>= 18）；尝试 `npm install --legacy-peer-deps` |
| **浏览器窗口未显示** | headless 模式 | 设置 `headless: false` 以显示 GUI 窗口 |
| **所有代理失效** | 代理质量不佳或网络环境变化 | `proxy_add` 添加新代理或刷新订阅源；检查 `subscription_urls` 是否可达 |
| **浏览器请求变慢** | 健康检测间隔过长导致过慢代理未被剔除 | 缩短 `health_check_interval`；检查各代理延迟 |
## 安全注意事项

- **扩展以用户完整权限运行**：Pi 扩展系统设计如此，无内置沙箱。仅从信任的来源安装扩展。
- **CloakBrowser 二进制校验**：从 CloakHQ 服务器下载的 Chromium 二进制文件会进行 SHA-256 校验。默认启用，不推荐关闭（`CLOAKBROWSER_SKIP_CHECKSUM`）。
- **SearXNG 实例信任**：使用公共 SearXNG 实例时，搜索查询会经过第三方服务器。敏感或隐私查询建议自部署 SearXNG。
- **代理凭据安全**：HTTP/HTTPS/SOCKS5 代理的认证凭据会以明文传输，避免在不信任的网络中使用。
- **IP 池代理风险**：免费代理来源不可控，传输的数据可能被中间人劫持。使用 IP 池时避免传输敏感信息（如登录凭据、API Key）。启用代理验证（建议 HTTPS 站点）或仅在低敏感场景使用。
- **截图清理**：截图文件保存在 `/tmp/` 目录，可能包含登录态、个人数据等敏感信息。建议在会话结束后手动清理。

## Token 效率

pi-web-toolkit 集成了 Token 预算管理模块 (`lib/token-budget.ts`)，自动记录每次工具调用的 Token 消耗：

| 工具 | Token 优化 | 预估节省 |
|------|-----------|---------|
| `web_search` | `max_results` 默认 5（原隐性 20），`brief` 模式省略摘要 | ~70% |
| `fetch_url` | `max_length` 默认 8000，无浏览器开销 | ~50% vs browser |
| `web_fetch` | 纯标题+URL，无摘要 | ~80% vs web_search |
| `browser_navigate` | `extract_text` 默认 `"summary"`（原 `true`=全文本） | ~80% |
| `browser_extract` / `browser_evaluate` | 自动记录用量 | — |

每次工具调用结束后自动调用 `recordToolUsage()` 记录到全局预算，LLM 可通过压力标签感知上下文窗口使用率。
