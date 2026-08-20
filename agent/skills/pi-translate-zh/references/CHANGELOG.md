# 改进说明（v11/v10/v8 历史 + 机制说明）

> 原位于 SKILL.md 正文，外置至此。执行翻译不依赖本文件；排查历史行为时阅读。


### v11 改进

- **修复覆盖率双算**：中英混合模板（如 `启用/禁用 Ctrl+P 循环的模型`）此前同时匹配英文/中文两个正则导致 total 虚高、pct 偏低。现改为先收集全部 description/label 模板再按内容分类，slash-commands 85%→100%、settings-selector 88%→100%
- **修复标识符误报**：纯标识符拼接模板（如 `${m.provider}/${m.id}`）去插值后无字母无中文，不再计入未翻译项（原报 interactive-mode 0/1 为误报）
- **新增未翻译条目清单**：覆盖率报告后直接列出仍为英文的 description/label 条目（每文件前 3 条），pi update 后可据此快速定位新增字符串
- **新增未匹配警告**：apply() 的未匹配条目（原文在当前版本不存在）不再仅在干跑模式输出，正常运行结束也汇总警告并附示例，提示可能已删除/移位/已被翻译
- **跳过节汇总**："跳过：不存在"逐行输出后增加一行汇总（N 节跳过：对应扩展未安装，安装后重跑脚本即可自动翻译）
- **新增 model-resolver 消息节**：`No models available. Check your installation or add models to models.json.` 自 interactive-mode.js 移位至 core/model-resolver.js（0.84 重构），已迁移翻译条目

### v10 改进

- **移除** `browser-automation` 和 `searx-search` 扩展引用（现名 `pi-web-search`/`pi-browser`；旧 pi-web-toolkit 名已废弃）
- **清理** 文档中已删除扩展的残留引用

### v8 改进

- **新增** `Default project trust` 设置项翻译（label/description + 三个子选项）
- **新增** 资源配置中 `Skills`/`Themes` 标签翻译
- **新增** 交互模式区段标题（Skills/Prompts/Extensions/Themes）翻译
- **新增** 交互模式通用消息翻译（确认按钮、认证方式选择、导入/分享提示等）
- **新增** 会话选择器排序/筛选标签翻译（Recent/Fuzzy/All/Named）
- **新增** 登录对话框链接提示 fallback 翻译
- **新增** `browser-automation` 和 `searxng-search` 用户 skill 描述翻译（后续已移除，见 v10）
- **新增** `context-mode` 全部 8 个技能描述翻译（context-mode、ctx-doctor、ctx-index、ctx-insight、ctx-purge、ctx-search、ctx-stats、ctx-upgrade）（后续已移除）
- **新增** `pi-lens` 中 `/lens-tdi` 和 `/lens-health` 命令描述翻译（后续已移除）
- **新增** `pi-subagents` 扩展工具 label 和 description 翻译（后续已移除）

### 自动路径检测
脚本不再硬编码 pi 安装路径，而是自动探测：
1. 常见全局安装路径 (`/usr/lib`, `/usr/local/lib`)
2. `npm root -g` 输出
3. `require.resolve()` 模块解析
4. 家目录下 node_modules 搜索

兼容 nvm、npm global、自定义 prefix 等各种安装方式。

### 备份机制
每次修改文件前，自动创建 `.bak.时间戳` 备份。如需恢复：

```bash
# 查看备份文件
ls -la /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/*.bak.*
# 还原（以 settings-selector.js 为例）
cp settings-selector.js.bak.1234567890 settings-selector.js
```

### 增量安全
已翻译的字符串不会被重复替换。多次运行脚本不会损坏文件。

### 翻译覆盖率统计
每次运行后输出各文件的翻译覆盖率，直观显示翻译状态。

| 文件 | 覆盖状态 |
|------|---------|
| `slash-commands.js` | 100%（22/22） |
| `settings-selector.js` | 100%（66/66） |
| `thinking-selector.js` | 100% |
| `status-indicator.js` | 100% |
| `interactive-mode.js` | ~40+ 条（非 description/label 格式的独立统计） |
| `model-resolver.js` | 核心消息已覆盖 |
| `agent-session.js` / `provider-composer.js` | 核心消息已覆盖 |
