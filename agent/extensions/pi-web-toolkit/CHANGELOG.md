# 修改记录

所有对本项目的修改均记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.1.0] - 2026-07-07

### 新增

- **`fetch_url` 工具**：轻量 HTTP GET，无需启动浏览器。15s 超时，`max_length` 控制 Token 开销。适合 API/JSON/纯文本/Markdown。
- **`web_fetch` 工具**：轻量 HTTP 搜索，直接解析 Bing HTML。不依赖 SearXNG，作为搜索不可用时的 fallback。

### 变更

- **三级搜索通路**：`web_search`（SearXNG 首选）→ `web_fetch`（Bing 直搜备选）→ `fetch_url` + Bing（最终 fallback）。
- **README 架构图更新**：新增 `fetch_url` 和 `web_fetch` 节点。
- **README 目录结构更新**：新增 `fetch.ts` 文件条目。
- **Token 效率表更新**：新增 `fetch_url`（~50% vs browser）和 `web_fetch`（~80% vs web_search）。

## [2.0.0] - 2026-07-06

### 重构 — 代理控制系统

- **IP 池 → 代理控制**：`ip_pool_*` 工具全部重命名为 `proxy_*`（`proxy_status`、`proxy_add`、`proxy_rotate`），语义从"IP 池"升级为"代理控制"。
- **新增 `proxy_on`**：启用系统级代理，设置 `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy` 环境变量指向 sing-box，所有子进程流量自动走代理。
- **新增 `proxy_off`**：禁用系统级代理，清空环境变量并停止 sing-box。
- **新增 `proxy_set`**：一键操作——添加代理地址 → 自动选中 → 启用系统代理。
- **`ProxyPool` 扩展**：新增 `enableSystemProxy()` / `disableSystemProxy()` / `isRunning()` / `isSystemProxyEnabled()` 方法，`getStats()` 返回新增 `systemProxyEnabled` 和 `systemProxyUrl` 字段。
- **系统代理生命周期**：`session_shutdown` 时自动清理系统代理环境变量并停止 sing-box。
- **ProxyHub 文档清理**：README 移除 ProxyHub 上游项目引用、架构图改为系统代理 env vars 模式、配置示例更新。
- **测试覆盖**：新增 `tests/proxy-control.test.ts`（6 个测试，覆盖全部 6 个代理工具）。

### 移除

- 移除 README 中所有 ProxyHub 相关文档和故障排查条目。
- 移除 git 跟踪的旧路径测试脚本（原 `../../../test_proxies.py` 和 `../../../test_global_proxies.py`），已移至 `scripts/` 目录。

## [1.3.0] - 2026-06-27

### 修复

- **cleanScreenshots 逻辑错误**：v1.2.0 的"保留最近 20 张"修复存在 Bug，第二个 `for` 循环无条件删除全部剩余文件，导致 `session_shutdown` 和 `session_compact` 都清空了所有截图。拆为 `cleanScreenshots()`（全删，`session_shutdown` 用）和 `trimScreenshots()`（保留最近 20 张，`session_compact` 用），使 `session_compact` 的清理行为与修改记录描述一致。
- **错误返回方式不符合 Pi API 规范**：官方文档规定必须 `throw Error` 才能标记工具执行失败，返回对象中包含 `isError: true` 会被 Pi 忽略。将 `browser_evaluate` 的 catch 块和 `browser_click` 的参数缺失校验改为 `throw Error`。
- **browser_click 参数检查顺序**：`requirePage()` 在参数校验之前调用，未提供 x/y/selector 时给出"尚未打开页面"的误导信息。改为先校验参数再调用 `requirePage()`。
- **mihomo 启动失败导致扩展加载崩溃**：ProxyPool 初始化失败时整个扩展加载失败。改为 try-catch 包裹，失败时优雅降级（跳过 IP 池工具，搜索和浏览器功能正常，日志输出错误原因）。

### 变更

- **config.ts 支持 Pi 重分发**：使用 `PI_CONFIG_DIR` 本地常量，运行时尝试从 Pi 包获取 `CONFIG_DIR_NAME`，失败回退 `.pi`。
- **env.d.ts 类型增强**：补充 `ExtensionContext`（`mode`/`hasUI`/`cwd`/`signal`/`ui`/`sessionManager` 等）、`ExtensionCommandContext`、`prepareArguments`、`registerCommand` 接口，移除不准确的 `isError` 字段。
- **合并 import**：`@earendil-works/pi-coding-agent` 的三条类型导入合并为一行。

## [1.2.1] - 2026-06-16

### 修复

- **`fetchWithRetry` 语法错误**：`catch { }` 块中使用无表达式 `throw` 导致扩展加载失败。改为 `catch (e)` + `throw e`，修正 SyntaxError。

## [1.2.0] - 2026-06-16

### 修复

- **browserActive 标志与浏览器真实状态同步**：移除易失的独立 `browserActive` boolean，改用 `BrowserManager.isPageActive()` 实时查询。浏览器异常崩溃后工具调用会正确报错而非进入损坏状态。
- **执行器签名补全**：所有 12 个工具的 `execute` 方法补充 `onUpdate: AgentToolUpdateCallback` 和 `ctx: ExtensionContext` 参数，符合 Pi ExtensionAPI 完整签名规范。
- **错误返回统一使用 `isError: true`**：`typeError`/`browser_evaluate` 等方法中的错误改回结构化 `{ isError: true }` 形式，LLM 能从上下文准确识别操作失败。
- **搜索模块 AbortSignal 前置检查**：`searchWeb()` 入口处先检查 `signal?.aborted`，用户取消操作时立即返回"搜索已取消"。
- **搜索 502 自动重试**：提取 `fetchWithRetry()` 函数，对 SearXNG 偶发 502/网络抖动自动重试一次（间隔 500ms），减少 LLM 重试开销。

### 变更

- **截图清理策略增强**：`cleanScreenshots()` 不再清空所有截图，改为保留最近 20 张，防止长时间会话中 `/tmp/` 磁盘占用膨胀。
- **代理池 entries 上限保护**：`ProxyPool.addProxies()` 新增 `max_entries` 上限（默认 500），超出时自动淘汰最久未使用代理，防止订阅源无限增长。
- **生命周期扩展**：新增 `session_compact` 事件监听，上下文压缩时同步清理截图文件。
- **配置注释**：`search_timeout` 字段在 `config.ts` 中添加命名映射注释，降低维护心智负担。

### 新增

- **所有工具添加 promptSnippet 和 promptGuidelines**：12 个工具均包含单行摘要（`promptSnippet`）和使用策略指南（`promptGuidelines`），帮助 LLM 在系统提示词中理解工具的正确使用场景和顺序。

## [1.1.0] - 2026-06-14

### 新增

- **IP 池系统**：新增 `ProxyPool` 核心模块 (`src/proxy-pool.ts`)，提供自动代理管理、健康检查和轮转能力。
  - **三种选择策略**：随机、轮询（round-robin）、最低延迟优先（top-3 随机防热点）
  - **健康检查**：后台定时通过 TCP CONNECT 检测代理连通性并测量延迟
  - **失败兜底**：失败计数 + 自动禁用 + 冷却恢复 + 池空降级直连
  - **URL 订阅**：定时从远程 URL 拉取代理列表
  - **运行时管理**：支持动态添加/删除代理
- **内嵌 HTTP 前向代理**：`ProxyPool` 在 `127.0.0.1` 启动本地 HTTP 代理，CloakBrowser 固定指向该地址。IP 轮转对浏览器完全透明，无需重启浏览器实例。零额外依赖（纯 Node.js 内置模块）。
- **3 个新工具**：
  - `ip_pool_status` — 查看池状态（总数/存活/失效/平均延迟/各代理详情）
  - `ip_pool_add` — 运行时批量添加代理
  - `ip_pool_rotate` — 强制轮转当前代理 IP

### 变更

- **`browser.ts`**：构造函数新增可选 `proxyPool` 参数，`launchBrowser()` 中优先使用 ProxyPool 的本地代理地址。
- **`config.ts`**：支持从 `settings.json` 读取 `proxy_pool` 配置段。
- **`index.ts`**：配置启用 `proxy_pool` 时自动初始化 ProxyPool 并注册 IP 池工具；`session_shutdown` 时自动清理 ProxyPool 资源。

## [1.0.2] - 2026-06-13

### 修复

- **扩展加载崩溃**：`browser.ts` 将静态 `import { launch } from 'cloakbrowser'` 改为动态 `await import('cloakbrowser')`，未安装依赖时 pi 正常启动不再崩溃。浏览器工具被调用时返回友好安装提示而非 MODULE_NOT_FOUND 错误。

## [1.0.1] - 2026-06-13

### 修复

- **execute() 签名适配 Pi ExtensionAPI 规范**：全部 9 个工具改为标准签名 `(toolCallId, params, signal, onUpdate, ctx)`，返回结构化 `{ content, details }` 对象，而非纯字符串。
- **AbortSignal 传播链**：用户按 Escape 取消操作时，`signal` 正确传播到搜索请求（fetch AbortController）和浏览器导航（`page.goto`），取消后台操作。
- **ensureBrowser() 并发竞态锁**：添加 Promise 互斥锁 `initializing`，防止并行工具调用启动多个浏览器进程。
- **导航错误不再静默吞没**：`browser.navigate()` 增加 fallback 机制（先 `networkidle` 后 `load`），两次均失败时抛出含详细信息的错误。
- **`browserActive` 标志状态修复**：仅在 `browser.navigate()` 成功后设为 `true`，导航失败时错误正确传播，不误标记为活动。

### 新增

- **9 个工具全部添加 `label` 字段**：TUI 中工具显示更友好。
- **临时截图自动清理**：`session_shutdown` 时清理 `/tmp/pi-screenshot-*.png`，防止 `/tmp/` 垃圾堆积。
- **SearXNG 请求添加 User-Agent 请求头**：避免被 SearXNG 实例或中间件拦截。
- **`search.ts` 支持外部 AbortSignal**：结合内部超时 AbortController，支持双向取消。

### 新增（部署）

- **本地 SearXNG 一键部署脚本 `install.sh`**：自动检查环境、安装系统依赖、部署 SearXNG 到 `~/.pi/searxng/`、配置 Pi settings.json。
- **SearXNG 管理脚本**：`start-searxng.sh`、`~/.pi/searxng/stop.sh`、`~/.pi/searxng/start.sh`。
- **README 新增"本地 SearXNG 部署"章节**：包含一键部署、手动部署、管理命令、配置说明。

## [1.0.0] - 2026-06-13

### 新增

- **web_search 工具**：集成 SearXNG 元搜索引擎，支持多引擎组合、分类过滤、分页、时间范围筛选、语言指定。自动检测并报告不可用引擎。
- **browser_navigate 工具**：使用 CloakBrowser 隐身浏览器打开网页，自动绕过 Cloudflare Turnstile 和 reCAPTCHA v3 等反爬虫检测。
- **browser_screenshot 工具**：截取浏览器页面截图，支持整页截图模式。参考 browser-harness 截图驱动交互设计。
- **browser_click 工具**：混合点击模式 — 坐标点击（穿透 iframe/Shadow DOM/跨域框架）和 CSS 选择器点击（精准定位）二选一。
- **browser_type 工具**：在页面输入框或当前焦点元素中输入文本。
- **browser_scroll 工具**：页面滚动控制，支持方向和距离参数。
- **browser_extract 工具**：提取页面可见文本，支持 CSS 选择器限定范围。
- **browser_evaluate 工具**：在浏览器中执行任意 JavaScript，返回序列化结果。
- **browser_close 工具**：关闭浏览器实例，释放系统资源。
- **三级配置系统**：settings.json → 环境变量 → 内置默认值，灵活覆盖。
- **生命周期管理**：Pi 会话关闭时自动清理浏览器进程，防止资源泄漏。
- **SearXNG 稳健引擎策略**：支持指定引擎列表，自动跳过不可用引擎并报告失败引擎。

### 架构

- 基于 CloakBrowser npm 包（`cloakbrowser`）作为隐身浏览器引擎。
- 基于 SearXNG JSON API（`?format=json`）作为搜索后端，不涉及 SearXNG 源码修改。
- 参考 browser-harness 的坐标点击 + 截图驱动交互模式，纯 TypeScript 自实现 CDP 控制层。
- 不修改任何上游项目源码，所有集成通过 API/CDP 调用实现，支持独立更新。
