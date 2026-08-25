# Pi Browser

为 [Pi](https://pi.dev) 编写的浏览器操作扩展，集成 **CloakBrowser** 隐身浏览器与 **browser-harness** 交互模式，让 Pi 的 LLM 获得完整的页面渲染、交互与抓取能力。

> 本扩展由原 **pi-web-toolkit** 拆分而来，专注浏览器能力。搜索与轻量 HTTP 抓取（`web_search`/`web_fetch`/`fetch_url`）请使用 **pi-web-search** 扩展。

## 架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  Pi (AI 编码代理 CLI)                                                │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  pi-browser (Pi Extension, TypeScript)                         │  │
│  │                                                                 │  │
│  │  browser_navigate()  ──┐                                        │  │
│  │  browser_screenshot()   ├── CDP Protocol ──── CloakBrowser      │  │
│  │  browser_click()        │   (定制 Chromium)                     │  │
│  │  browser_type()        ─┘    │                                  │  │
│  │  browser_scroll()             │                                  │  │
│  │  …等 18 个 browser_* 工具      │                                  │  │
│  │  （wait_for/network/select_option/dialog/download/upload/       │  │
│  │   cookies/find/pdf/help——详见下方工具参考）                      │  │
│  │                                                                 │  │
│  │  交互模式参考: browser-harness (坐标点击 + 截图驱动)            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## 上游项目

| 项目 | 仓库 | 许可证 | 在本扩展中的角色 |
|------|------|--------|----------------|
| **CloakBrowser** | https://github.com/CloakHQ/CloakBrowser | MIT (封装器) + 自定义二进制 (Chromium) | 58 处 C++ 源码级隐身补丁的 Chromium，绕过反爬虫检测 |
| **browser-harness** | https://github.com/browser-use/browser-harness | MIT | 截图驱动 + 坐标点击的交互模式参考，穿透 iframe/Shadow DOM |
| **Pi** | https://pi.dev | MIT | 宿主平台，TypeScript 扩展系统 |

### 不修改源码的保证

| 项目 | 集成方式 | 更新方法 |
|------|---------|---------|
| CloakBrowser | npm 包 `cloakbrowser` 直接 `import { launch }` | `npm update cloakbrowser` |
| browser-harness | 仅参考设计模式，纯 TypeScript 自实现 | 无需更新（非直接依赖） |

## 安装

```bash
# 1. 安装依赖（仓库无 install.sh，用 npm 安装）
cd ~/.pi/agent/extensions/pi-browser && npm install && npx playwright install chromium

# 2. 启动 Pi（pi 0.83+ 从 extensions/ 目录自动发现，无需手动注册）
pi
```

CloakBrowser 首次启动会自动下载隐身 Chromium（约 200MB，存放在 `~/.cloakbrowser/`），请确保磁盘空间充足。

## Windows 便携版（部署）

浏览器：CloakBrowser 包自动下载官方 stealth Chromium 到 `~/.cloakbrowser/chromium-<ver>/chrome.exe`（或 Windows 实例中 `%USERPROFILE%\.cloakbrowser\`）。需要本地/定制版二进制时设 `CLOAKBROWSER_BINARY_PATH` 覆盖（如 `E:\pi-portable\.cloakbrowser\chromium-<ver>\chrome.exe`）。下载被墙时：先手动解压官方 zip 到 `~/.cloakbrowser/`，或设 `CLOAKBROWSER_DOWNLOAD_URL` 指向镜像，或用 `CLOAKBROWSER_BINARY_PATH` 指向已有 Chromium。注：Termux（Android）无官方预编译包，rebuild.sh 会自动用 `pkg install x11-repo chromium` 并设置 `CLOAKBROWSER_BINARY_PATH`。

Windows 便携探测（2026-08-17 合入，源自 portable-win）：`CLOAKBROWSER_BINARY_PATH` 未设或指向不存在文件时，`impl.ts` 自动探测 `%USERPROFILE%\.cloakbrowser\chromium-*/chrome.exe`（官方定制版优先），回退 npmmirror `%USERPROFILE%\tools\chrome-win64\chrome.exe`——不依赖 start.bat wrapper 环境。Windows 下强制 `--no-proxy-server` 直连（系统代理无效/被墙 → ERR_NETWORK_ACCESS_DENIED）。

## 配置

编辑 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级），仅需 `pi-browser` 配置段（扩展已由目录自动发现）：

```json
{
  "pi-browser": {
    "headless": false,
    "viewport_width": 1280,
    "viewport_height": 800,
    "fingerprint_seed": "my-fingerprint",
    "proxy": "http://127.0.0.1:8080",
    "data_dir": "~/.pi-browser/profile"
  }
}
```

> **兼容说明：** 配置段缺失的字段会自动回退读取旧版 `pi-web-toolkit` 配置段，升级拆分无需手动迁移。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_BROWSER_HEADLESS`（回退 `PI_WEB_TOOLKIT_HEADLESS`） | 无头模式 | `false` |
| `PI_BROWSER_VIEWPORT_WIDTH`（回退 `PI_WEB_TOOLKIT_VIEWPORT_WIDTH`） | 浏览器视口宽度 | `1280` |
| `PI_BROWSER_VIEWPORT_HEIGHT`（回退 `PI_WEB_TOOLKIT_VIEWPORT_HEIGHT`） | 浏览器视口高度 | `800` |
| `PI_BROWSER_FINGERPRINT_SEED`（回退 `PI_WEB_TOOLKIT_FINGERPRINT_SEED`） | 浏览器指纹种子 | （随机） |
| `PI_BROWSER_PROXY`（回退 `PI_WEB_TOOLKIT_PROXY`） | 代理地址 | （无） |

> 新前缀 `PI_BROWSER_*` 优先读取；旧前缀 `PI_WEB_TOOLKIT_*` 仅作向后兼容回退，同名变量新前缀生效。

### 配置优先级

**settings.json > 环境变量 > 内置默认值**

## 目录结构

```
~/.pi/agent/extensions/pi-browser/
├── index.ts                   # ★ 入口 orchestrator
├── config.ts                  # 配置聚合器：settings.json → 环境变量 → 默认值
├── types.ts                   # BrowserOnlyConfig
├── package.json               # npm 包配置，入口 → ./index.ts
├── tsconfig.json
│
├── browser/                   # 🌐 浏览器功能
│   ├── index.ts               #   registerBrowserTools()
│   ├── impl.ts                #   BrowserManager 类
│   ├── types.ts               #   BrowserConfig, PageInfo
│   └── config.ts              #   buildBrowserConfig()
│
└── tests/
    ├── browser.test.ts        # BrowserManager 单元测试
    └── index.test.ts          # 入口工具注册测试
```

## 工具参考

辅助工具（详见工具 schema）：`browser_cookies`（查看/设置 Cookie，登录态检查）、`browser_find`(穿透 Shadow DOM 定位元素坐标)、`browser_pdf`(当前页导出 PDF)、`browser_help`(交互机制手册：shadow/dropdown/dialog/download/network/scroll/iframe/wait/cookie/screenshot)。

### browser_navigate

使用 CloakBrowser 隐身浏览器打开 URL。自动绕过 Cloudflare Turnstile、reCAPTCHA v3 等多层反爬虫检测。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 完整 URL（须包含协议，如 `https://`） |
| `extract_text` | "summary" / "full" / "none" | 否 | 文本提取模式（默认 `"summary"`）。`summary` 返回结构化摘要（标题 + 要点），`full` 返回完整可见文本，`none` 跳过提取 |

**返回：** 页面标题、URL、视口大小、可见文本内容（summary 模式下为结构化摘要）。

> **与 fetch_url 分工（pi-web-search 扩展）：**
> - `fetch_url`：纯 HTTP GET，轻量（< 1s），适合 API/文档/纯文本
> - `browser_navigate`：完整浏览器渲染，适合需要 JS 执行的页面

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

## 使用场景示例

### 场景 1：协作式页面交互

```
用户: 帮我搜索 GitHub 上 star 最多的 Rust 项目

→ LLM 调用: browser_navigate(url="https://github.com/topics/rust?o=desc&s=stars")
→ LLM 调用: browser_screenshot()
→ LLM 分析截图，定位项目列表区域
→ LLM 调用: browser_extract(selector=".repo-list li h3")
```

### 场景 2：绕过反爬虫抓取

```
用户: 访问这个有验证保护的网站

→ LLM 调用: browser_navigate(url="https://example-protected.com")
            // CloakBrowser 自动处理 Cloudflare Turnstile / reCAPTCHA
→ LLM 调用: browser_screenshot()
→ LLM 调用: browser_click(x=500, y=300)
```

### 场景 3：抓取页面调用的 API 数据

```
用户: 看下这个页面的接口返回了什么

→ LLM: browser_network(clear=true)        // 清空旧日志，隔离本次请求
→ LLM: browser_click(selector=".load-btn") // 触发页面操作
→ LLM: browser_network(url_pattern="api/") // 只筛接口请求
```

> 日志自页面打开即持续记录；`url_pattern` 支持正则（如 `"api/"` 或 `"\\/users\\/\\d+"`）。

### 场景 4：加载慢 / 弹窗 / 表单

```
用户: 打开商品页，选择尺码，加入购物车

→ LLM:  browser_navigate(url="...")
→ LLM:  browser_wait_for(selector=".sku-select")         // 等元素就绪再操作
→ LLM:  browser_dialog(mode="accept")                   // 预先确认弹窗
→ LLM:  browser_select_option(selector=".sku-select", value="L")
→ LLM:  browser_click(selector="#add-cart")
```

### 场景 5：下载文件 / 上传表单

```
用户: 下载这个页面的 PDF

→ LLM:  browser_click(selector=".download-btn")   // 触发下载（事件自动监听保存）
→ LLM:  browser_download()                        // 拿到保存路径

用户: 把这个文件传到表单
→ LLM:  browser_upload(selector="input[type=file]", path="/tmp/xx.pdf")
```

> 下载默认存系统临时目录下 `pi-browser-downloads-<pid>`（会话隔离，shutdown 自动清理；重名自动加时间戳）；上传需先确知文件输入框选择器。

## 故障排查

| 问题 | 原因 | 解决方法 |
|------|------|---------|
| **CloakBrowser 下载失败** | 网络问题或磁盘空间不足 | 检查网络连接，确保 `~/.cloakbrowser/` 所在分区有 500MB+ 空间 |
| **CloakBrowser 无法启动** | 系统缺少依赖（Linux） | 安装：`apt install libnss3 libatk1.0-0 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 libgbm1 libpango-1.0-0 libcairo2` |
| **截图全黑/空白** | headless 模式无 GPU 渲染 | 设置 `headless: false`，或使用 Xvfb：`xvfb-run pi ...` |
| **坐标点击无响应** | 页面未完全加载 | 确认页面已加载完成；尝试先调用 `browser_screenshot` 确认页面状态 |
| **元素点击无响应** | 元素被遮挡或不在视口内 | 使用坐标模式点击；或先调用 `browser_scroll` 滚动到目标位置 |
| **浏览器窗口未显示** | headless 模式 | 设置 `headless: false` 以显示 GUI 窗口 |

## 安全注意事项

- **扩展以用户完整权限运行**：Pi 扩展系统设计如此，无内置沙箱。仅从信任的来源安装扩展。
- **CloakBrowser 二进制校验**：从 CloakHQ 服务器下载的 Chromium 二进制文件会进行 SHA-256 校验。默认启用，不推荐关闭（`CLOAKBROWSER_SKIP_CHECKSUM`）。
- **代理凭据安全**：HTTP/HTTPS/SOCKS5 代理的认证凭据会以明文传输，避免在不信任的网络中使用。
- **截图清理**：截图文件保存在 `/tmp/` 目录，可能包含登录态、个人数据等敏感信息。会话关闭时自动清理，建议避免长时间保留截图。
- **URL 协议校验（2026-08 审计）**：`browser_navigate` 只放行 http/https——拒绝 `file://`、`data:`、`javascript:` 等（防 prompt 注入导航读本地文件并经 extract_text 回传）；内网地址保留（本地服务/开发测试合法用途）。

## Token 效率

pi-browser 集成了 Token 预算管理模块 (`lib/token-budget.ts`、`lib/prune.ts`)，自动记录每次工具调用的 Token 消耗：

| 工具 | Token 优化 | 预估节省 |
|------|-----------|---------|
| `browser_navigate` | `extract_text` 默认 `"summary"`（原 `true`=全文本） | ~80% |
| `browser_screenshot` | 返回文件路径而非图片数据 | ~100% |
| `browser_extract` / `browser_evaluate` | 自动记录用量 + 输出截断 | — |

每次工具调用结束后自动调用 `recordToolUsage()` 记录工具使用计数（按工具累计 token 估算，仅供诊断统计，不注入 LLM 上下文）。上下文压力提示由 pi-context 扩展统一承担，本扩展不注入。
