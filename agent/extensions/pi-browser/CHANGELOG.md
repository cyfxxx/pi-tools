# 修改记录

所有对本项目的修改均记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-01

### 新增

- **从 pi-web-toolkit 拆分独立**：浏览器能力（8 个 `browser_*` 工具）从原 pi-web-toolkit 扩展中拆出，形成独立扩展，实现与搜索/HTTP 抓取功能（pi-web-search）的依赖与故障隔离。
- **工具清单**：`browser_navigate`、`browser_screenshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_extract`、`browser_evaluate`、`browser_close`。
- **CloakBrowser 集成**：隐身浏览器（58 处 C++ 源码级补丁的 Chromium），自动绕过 Cloudflare Turnstile / reCAPTCHA v3。
- **browser-harness 交互模式**：截图驱动 + 坐标点击，穿透 iframe/Shadow DOM/跨域框架。
- **生命周期管理**：`session_shutdown` 关闭浏览器并清理 `/tmp/pi-screenshot-*.png`；`session_compact` 保留最近 20 张截图；`session_start` 重置 Token/输出预算。

### 变更

- **配置段 `pi-browser`**：浏览器配置迁移至 `settings.json` 的 `pi-browser` 段；字段缺失时自动回退读取旧 `pi-web-toolkit` 段，无需手动迁移。
- **环境变量保留原前缀**：`PI_WEB_TOOLKIT_HEADLESS` 等环境变量名不变，避免破坏既有部署。

### 集成

- 共享 `lib/token-budget.ts`、`lib/prune.ts`（与 pi-web-search、plan-mode 等扩展平级共享）。
