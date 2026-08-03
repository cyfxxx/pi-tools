# Changelog — pi-translate-zh

## [v11] — 2026-08-02（适配 pi 0.83.0）

### Changed
- 适配 pi 0.83.0 字符串变化：
  - `/reload` 命令描述新增 `, and context files`（slash-commands + interactive-mode 三条 reload 消息）
  - 思考深度 `xhigh` 从 "Maximum reasoning" 改为 "Extra-high reasoning"，`max` 仍为 "Maximum reasoning"（settings-selector + thinking-selector 两个文件，新增 thinking-selector 区段）
  - 压缩状态指示器从 interactive-mode 移至 `status-indicator.js`（新增区段，含模板字面量匹配）
  - 项目信任警告改为模板字面量 `This project is not trusted. Project ${CONFIG_DIR_NAME}...`
  - 认证方式选择改为 `Select authentication method for ${providerOptions[0].name}:` 模板字面量
  - Bedrock 提示改为 `You can also use an AWS profile, IAM keys, or role-based credentials.`
  - `Nothing to compact` 移至 agent-session.js（"session too small"，新增区段）
  - `Enter API key` 移至 provider-composer.js（message: 形式，新增区段）
  - config-selector 标题改为 `Project Local Resources`/`Global Resources`，组标签改为运行时拼接模板字面量，新增 "switch mode"/"cycle inherit/+/- "/"toggle" 提示
- 设置菜单新增：Automatic/Light theme/Dark theme/Apply/Change mode/Cache miss notices/Output padding 等 15 项
- 清理已删除字符串的旧条目（No editor configured、AWS credentials、Use a subscription、Amazon Bedrock setup、Resource Configuration、Type to filter resources、Select color theme、plan-mode 旧英文描述）
- 删除 plan-mode 英文描述区段（index.ts 已为中文，`apply(EXT, [])`）

## [v10] — 2026-06-15

### Removed
- `browser-automation` 和 `searx-search` 扩展引用（已被 pi-web-toolkit 替代）
- SKILL.md 中对应的覆盖率表格行和查找命令

### Changed
- 清理文档中已废弃扩展的引用

## [v9] — 2026-06-13

### Changed
- 脚本提升为完全自动检测 pi 安装路径（npm root -g、require.resolve、常见全局路径、家目录 node_modules）
- 翻译覆盖范围大幅扩展

### Added
- `browser-automation` 扩展命令翻译（4 条）
- `ctx-lite` 扩展命令翻译（4 条）
- `plan-mode` 扩展命令/标志翻译（5 条）
- `searx-search` 扩展工具/命令翻译（7 项）
- @plannotator/pi-extension 命令/标志翻译（9 条）+ 技能描述（6 个）
- pi-lens 标志/命令翻译（17 项）+ 技能描述（4 个）
- pi-markdown-preview 命令/参数翻译（14 条）
- plannotator.html UI 文字翻译（47 项）
- review-editor.html UI 文字翻译（97 项）

## [v8]

### Added
- `Default project trust` 设置项翻译（label/description + 三个子选项）
- 资源配置中 `Skills`/`Themes` 标签翻译
- 交互模式区段标题（Skills/Prompts/Extensions/Themes）翻译
- 交互模式通用消息翻译（确认按钮、认证方式选择、导入/分享提示等）
- 会话选择器排序/筛选标签翻译（Recent/Fuzzy/All/Named）
- 登录对话框链接提示 fallback 翻译
- `context-mode` 全部 8 个技能描述翻译
- `pi-subagents` 扩展工具 label 和 description 翻译

### Changed
- 自动路径检测：不再硬编码 pi 安装路径
- 备份机制：每次修改前创建 `.bak.时间戳` 备份
- 增量安全：已翻译字符串不会被重复替换
- 翻译覆盖率统计：运行后输出各文件覆盖率

## [初始版本]

将 pi TUI 的命令描述、设置菜单、技能描述等翻译为中文。
适用于 pi update 后重新翻译。
