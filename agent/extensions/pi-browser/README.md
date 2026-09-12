# pi-browser — 浏览器操作扩展

> 为 [Pi](https://pi.dev) 编写的浏览器操作扩展，集成 **CloakBrowser** 隐身浏览器与 **browser-harness** 交互模式，让 Pi 的 LLM 获得完整的页面渲染、交互与抓取能力。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 浏览器操作、页面抓取 |
| 相关文档 | [pi-web-search](../pi-web-search/README.md), [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、安装与部署](#六安装与部署)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 需要浏览器能力来：
- 渲染 JavaScript 密集型页面
- 绕过反爬虫检测
- 进行复杂的页面交互

### 1.2 设计理念

- **隐身浏览**：CloakBrowser 绕过 Cloudflare Turnstile、reCAPTCHA v3 等反爬虫检测
- **截图驱动**：结合截图分析进行精准坐标点击
- **Token 效率**：内置预算管理，自动优化返回内容

---

## 二、架构

### 2.1 系统架构图

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
│  │                                                                 │  │
│  │  交互模式参考: browser-harness (坐标点击 + 截图驱动)            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 入口层 | `index.ts` | 扩展注册和初始化 |
| 配置层 | `config.ts` | 配置聚合和验证 |
| 浏览器层 | `browser/` | CloakBrowser 封装和管理 |
| 测试层 | `tests/` | 单元测试和集成测试 |

---

## 三、功能

### 3.1 工具清单

| 工具 | 参数 | 说明 |
|------|------|------|
| `browser_navigate` | `url`, `extract_text?` | 使用 CloakBrowser 打开 URL |
| `browser_screenshot` | `full_page?` | 截取当前页面截图 |
| `browser_click` | `x?`, `y?`, `selector?`, `button?` | 点击元素（坐标或选择器模式） |
| `browser_type` | `text`, `selector?` | 输入文本 |
| `browser_scroll` | `direction?`, `amount?` | 滚动页面 |
| `browser_extract` | `selector?` | 提取页面可见文本 |
| `browser_evaluate` | `script` | 执行 JavaScript 代码 |
| `browser_close` | — | 关闭浏览器实例 |
| `browser_cookies` | — | 查看/设置 Cookie |
| `browser_find` | — | 穿透 Shadow DOM 定位元素坐标 |
| `browser_pdf` | — | 当前页导出 PDF |
| `browser_help` | — | 交互机制手册 |

### 3.2 交互模式

**坐标模式（推荐）**：
1. 调用 `browser_screenshot()` 获取页面截图
2. 分析截图，估算目标元素的坐标位置
3. 调用 `browser_click(x=420, y=580)` 进行点击

**选择器模式**：
- 提供 CSS 选择器，精准定位元素
- 如 `"button#submit"`、`".search-btn"`、`"a[href*='login']"`

### 3.3 与 pi-web-search 的分工

- **pi-browser**：完整浏览器渲染，适合需要 JS 执行的页面
- **pi-web-search**：纯 HTTP GET，轻量（< 1s），适合 API/文档/纯文本

---

## 四、配置项

### 4.1 配置文件

编辑 `~/.pi/agent/settings.json`（全局）或 `.pi/settings.json`（项目级）：

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

### 4.2 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PI_BROWSER_HEADLESS` | 无头模式 | `false` |
| `PI_BROWSER_VIEWPORT_WIDTH` | 浏览器视口宽度 | `1280` |
| `PI_BROWSER_VIEWPORT_HEIGHT` | 浏览器视口高度 | `800` |
| `PI_BROWSER_FINGERPRINT_SEED` | 浏览器指纹种子 | （随机） |
| `PI_BROWSER_PROXY` | 代理地址 | （无） |

### 4.3 配置优先级

**settings.json > 环境变量 > 内置默认值**

---

## 五、使用方法

### 5.1 基本用法

```bash
# 打开页面
browser_navigate(url="https://example.com")

# 截图并分析
browser_screenshot()

# 点击元素
browser_click(x=420, y=580)

# 输入文本
browser_type(text="搜索关键词", selector="#search")
```

### 5.2 使用场景示例

**场景 1：协作式页面交互**

```
用户: 帮我搜索 GitHub 上 star 最多的 Rust 项目

→ LLM 调用: browser_navigate(url="https://github.com/topics/rust?o=desc&s=stars")
→ LLM 调用: browser_screenshot()
→ LLM 分析截图，定位项目列表区域
→ LLM 调用: browser_extract(selector=".repo-list li h3")
```

**场景 2：绕过反爬虫抓取**

```
用户: 访问这个有验证保护的网站

→ LLM 调用: browser_navigate(url="https://example-protected.com")
            // CloakBrowser 自动处理 Cloudflare Turnstile / reCAPTCHA
→ LLM 调用: browser_screenshot()
→ LLM 调用: browser_click(x=500, y=300)
```

**场景 3：抓取页面调用的 API 数据**

```
用户: 看下这个页面的接口返回了什么

→ LLM: browser_network(clear=true)        // 清空旧日志，隔离本次请求
→ LLM: browser_click(selector=".load-btn") // 触发页面操作
→ LLM: browser_network(url_pattern="api/") // 只筛接口请求
```

**场景 4：加载慢 / 弹窗 / 表单**

```
用户: 打开商品页，选择尺码，加入购物车

→ LLM:  browser_navigate(url="...")
→ LLM:  browser_wait_for(selector=".sku-select")         // 等元素就绪再操作
→ LLM:  browser_dialog(mode="accept")                   // 预先确认弹窗
→ LLM:  browser_select_option(selector=".sku-select", value="L")
→ LLM:  browser_click(selector="#add-cart")
```

**场景 5：下载文件 / 上传表单**

```
用户: 下载这个页面的 PDF

→ LLM:  browser_click(selector=".download-btn")   // 触发下载
→ LLM:  browser_download()                        // 拿到保存路径

用户: 把这个文件传到表单
→ LLM:  browser_upload(selector="input[type=file]", path="/tmp/xx.pdf")
```

---

## 六、安装与部署

### 6.1 前置条件

- Node.js >= 18
- Pi 已安装并可用

### 6.2 安装步骤

```bash
# 1. 安装依赖
cd ~/.pi/agent/extensions/pi-browser && npm install && npx playwright install chromium

# 2. 启动 Pi（pi 0.83+ 从 extensions/ 目录自动发现，无需手动注册）
pi
```

CloakBrowser 首次启动会自动下载隐身 Chromium（约 200MB，存放在 `~/.cloakbrowser/`），请确保磁盘空间充足。

### 6.3 Windows 便携版

浏览器：CloakBrowser 包自动下载官方 stealth Chromium 到 `~/.cloakbrowser/chromium-<ver>/chrome.exe`。

需要本地/定制版二进制时设 `CLOAKBROWSER_BINARY_PATH` 覆盖。

### 6.4 Termux/Android 环境

Termux（Android）无官方预编译包，rebuild.sh 会自动用 `pkg install x11-repo chromium` 并设置 `CLOAKBROWSER_BINARY_PATH`。

---

## 七、已知问题

- **CloakBrowser 下载失败**：网络问题或磁盘空间不足，检查网络连接，确保 `~/.cloakbrowser/` 所在分区有 500MB+ 空间
- **CloakBrowser 无法启动**：系统缺少依赖（Linux），安装相关依赖包
- **截图全黑/空白**：headless 模式无 GPU 渲染，设置 `headless: false`，或使用 Xvfb
- **坐标点击无响应**：页面未完全加载，确认页面已加载完成
- **元素点击无响应**：元素被遮挡或不在视口内，使用坐标模式点击

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-browser
npm install
npx vitest run
```

### 8.2 验证检查清单

- [ ] `npm install` 成功完成
- [ ] `browser_navigate` 能打开页面
- [ ] `browser_screenshot` 能获取截图
- [ ] `browser_click` 能点击元素

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-08-XX | v1.0 | 初始版本，实现浏览器操作功能 |

---

## 十、安全注意事项

- **扩展以用户完整权限运行**：Pi 扩展系统设计如此，无内置沙箱。仅从信任的来源安装扩展。
- **CloakBrowser 二进制校验**：从 CloakHQ 服务器下载的 Chromium 二进制文件会进行 SHA-256 校验。
- **代理凭据安全**：HTTP/HTTPS/SOCKS5 代理的认证凭据会以明文传输，避免在不信任的网络中使用。
- **截图清理**：截图文件保存在 `/tmp/` 目录，可能包含敏感信息。会话关闭时自动清理。
- **URL 协议校验**：`browser_navigate` 只放行 http/https——拒绝 `file://`、`data:`、`javascript:` 等。

---

## 十一、上游项目

| 项目 | 仓库 | 许可证 | 在本扩展中的角色 |
|------|------|--------|----------------|
| **CloakBrowser** | https://github.com/CloakHQ/CloakBrowser | MIT (封装器) + 自定义二进制 (Chromium) | 58 处 C++ 源码级隐身补丁的 Chromium |
| **browser-harness** | https://github.com/browser-use/browser-harness | MIT | 截图驱动 + 坐标点击的交互模式参考 |
| **Pi** | https://pi.dev | MIT | 宿主平台，TypeScript 扩展系统 |

### 不修改源码的保证

| 项目 | 集成方式 | 更新方法 |
|------|---------|---------|
| CloakBrowser | npm 包 `cloakbrowser` 直接 `import { launch }` | `npm update cloakbrowser` |
| browser-harness | 仅参考设计模式，纯 TypeScript 自实现 | 无需更新（非直接依赖） |