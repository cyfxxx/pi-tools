# Changelog — pi-translate-zh

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
