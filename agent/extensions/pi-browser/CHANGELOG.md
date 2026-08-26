# 修改记录

所有对本项目的修改均记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.2.2] - 2026-08-26

### 修复（全项目审计）

- **dialog 回调竞态 unhandledRejection（MEDIUM）**：async 回调内 accept/dismiss 在页面关闭竞态时 reject 无 catch 可崩整个 pi 进程（对照 download 监听已有 .catch）——提取 action Promise 统一 .catch 记录调试日志，accept/input/dismiss 三分支语义不变。

## [1.2.1] - 2026-08-25

### 修复（全项目审计）

- **CLOAKBROWSER_BINARY_PATH 相对路径依赖 cwd**：ensureLocalBinaryEnv 先 resolve 归一再判断，存在则回写绝对路径（后续 launch 不再受 cwd 变化影响）。
- **崩溃残留 tmpdir 永久累积**：session_start 后台清扫非本 pid 且进程已死的 `pi-browser-{screenshots,pdf,downloads}-<pid>` 目录（探活防误杀活跃实例）。
- **下载 filename 越目录写**：suggestedFilename() 统一分隔符后取 basename，滤空/`.`/`..`（回退默认名）再落盘。

## [1.2.0] - 2026-08-25

### 修复（全项目审计）

- **win32 强制直连覆盖显式代理**：`--no-proxy-server` 此前无条件附加，静默忽略 config.proxy 与环境代理——改为仅当无任何显式代理配置时附加。
- **协议安全拒绝被吞后重试**：navigate 重定向到不允许协议的拒绝错误被外层 catch 吞掉后以 load 模式重试 goto 且错误信息降级——识别安全拒绝立即 rethrow，保留具体文案；网络类错误回退逻辑不变。
- **并发同名下载互相覆盖**：saveDownload 去重只查已完成的 downloadedFiles 数组——新增 in-flight 占位集合共同去重，冲突生成唯一后缀。

## [1.1.0] - 2026-08-24

### 新增

- **交互能力补齐（源自 browser-harness 参考）**：新增 4 个 `browser_*` 工具——`browser_wait_for`（等待元素/网络空闲，超时不抛错）、`browser_network`（网络请求日志，URL/方法/类型过滤 + clear 重记）、`browser_select_option`（下拉框按 value/文本选择）、`browser_dialog`（JS 弹窗策略 accept/dismiss/input + 最近弹窗文本）。
- **文件与登录态**：`browser_download`（下载自动监听/保存/查询，可换目录）、`browser_upload`（`setInputFiles` 上传）、`browser_cookies`（get/set）、`browser_pdf`（打印当前页为 PDF）。
- **Shadow DOM 定位**：`browser_find`（深层穿透所有 shadow-root 查元素，返回中心坐标供 browser_click 坐标模式使用）。
- **交互手册**：`references/interaction.md`（从 browser-harness interaction-skills 提炼的 Web 交互要领：坐标/DPR 陷阱、shadow、下拉、弹窗、下载上传、网络、滚动、iframe、等待、cookie）+ `browser_help(topic)` 工具按需查询对应章节（不注入系统提示词）。
- **网络监听**：`BrowserManager` 从页面打开即持续记录请求（保留最近 1000 条），响应状态码自动回填。
- **下载监听**：`download` 事件自动保存到 `~/.pi-browser-downloads`（可改），重名自动加时间戳后缀。
- **弹窗默认策略**：默认 dismiss（不阻塞），避免 alert/confirm 卡住流程。

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
