---
name: pi-translate-zh
description: 将 pi TUI 的命令描述、设置菜单、子菜单、提示词描述、扩展命令、npm 插件文字、技能描述翻译为中文。适用于 pi update 后重新翻译。
---

# 补丁：pi TUI 完整中文化

## 适用场景

- `pi update` 后中文翻译被覆盖，需要重新应用
- 首次安装后需要中文化

> **当用户要求修复中文化失效时**，执行本节即可。

## 重新翻译

```bash
node ~/.pi/agent/skills/pi-translate-zh/patch-all-zh.mjs
```

重启 pi 后生效。

## 改进说明 (v10)

### v10 改进

- **移除** `browser-automation` 和 `searx-search` 扩展引用（已被 `pi-web-toolkit` 替代）
- **清理** 文档中已删除扩展的残留引用

### v8 改进

- **新增** `Default project trust` 设置项翻译（label/description + 三个子选项）
- **新增** 资源配置中 `Skills`/`Themes` 标签翻译
- **新增** 交互模式区段标题（Skills/Prompts/Extensions/Themes）翻译
- **新增** 交互模式通用消息翻译（确认按钮、认证方式选择、导入/分享提示等）
- **新增** 会话选择器排序/筛选标签翻译（Recent/Fuzzy/All/Named）
- **新增** 登录对话框链接提示 fallback 翻译
- **新增** `browser-automation` 和 `searxng-search` 用户 skill 描述翻译
- **新增** `context-mode` 全部 8 个技能描述翻译（context-mode、ctx-doctor、ctx-index、ctx-insight、ctx-purge、ctx-search、ctx-stats、ctx-upgrade）
- **新增** `pi-lens` 中 `/lens-tdi` 和 `/lens-health` 命令描述翻译
- **新增** `pi-subagents` 扩展工具 label 和 description 翻译

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
| `slash-commands.js` | ~85% |
| `settings-selector.js` | ~85% |
| `interactive-mode.js` | ~40+ 条（非 description/label 格式的独立统计） |
| `pi-lens/index.ts` | ~53% |
| `@plannotator/pi-extension/index.ts` | ~59% |
| `pi-markdown-preview/index.ts` | ~46% |

## 覆盖范围

| 类别 | 来源 | 数量 |
|------|------|------|
| 内置命令描述 | `pi-coding-agent/dist/core/slash-commands.js` | 22 条 |
| 设置菜单：标签/描述/子菜单/思考深度 | `settings-selector.js` | ~59 项 |
| 交互模式：状态/错误/提示消息 | `interactive-mode.js` | ~65 条 |
| 资源配置：扩展/提示词/设置页标签 | `config-selector.js` | 8 项 |
| 登录对话框 | `login-dialog.js` | 3 项 |
| 会话选择器 | `session-selector.js` | 8 项 |
| 树导航 | `tree-selector.js` | 2 项 |
| 模型选择器 | `model-selector.js` | 2 项 |
| OAuth 提供商选择器 | `oauth-selector.js` | 5 项 |
| CLI 主入口：提示/警告/错误 | `main.js` | 9 项 |
| 启动页脚 | `daxnuts.js` | 2 项 |
| pi-subagents 命令 + 状态消息 | `pi-subagents/src/slash/slash-commands.ts` | 12 项 |
| pi-subagents 提示词描述 | `pi-subagents/prompts/*.md` | 7 个 |
| pi-subagents 技能描述 | `pi-subagents/skills/*/SKILL.md` | 1 个 |
| rpiv-todo 命令 + 本地化 | `rpiv-todo/todo.ts` + `locale/zh.json` | 2 条 |
| **ctx-lite 扩展命令** | `extensions/ctx-lite.ts` | **4 条** |
| **plan-mode 扩展命令/标志** | `extensions/plan-mode/index.ts` | **5 条** |
| **@plannotator/pi-extension 命令/标志** | `index.ts` | **9 条** |
| **@plannotator/pi-extension 技能** | `skills/*/SKILL.md` | **6 个** |
| **pi-lens 标志/命令** | `index.ts` | **17 项** |
| **pi-lens 技能** | `skills/*/SKILL.md` | **4 个** |
| **pi-markdown-preview 命令/参数** | `index.ts` | **14 条** |
| **plannotator.html UI 文字** | `plannotator.html` | **47 项** |
| **review-editor.html UI 文字** | `review-editor.html` | **97 项** |

## 自定义翻译

编辑 `patch-all-zh.mjs` 中的对应字符串即可。

## pi 更新后查找需要翻译的新文件

pi update 后可能新增或修改界面文字。以下排查步骤定位需要补充翻译的位置：

### 1. 查找未翻译的 description/label

```bash
# pi 核心命令
PI=/usr/lib/node_modules/@earendil-works/pi-coding-agent
grep -rn 'description:\s*"[A-Z]\|label:\s*"[A-Z]' "$PI/dist/" --include='*.js' | grep -v node_modules

# npm 包扩展命令
grep -rn 'description:\s*"[A-Z]\|label:\s*"[A-Z]' /root/.pi/agent/npm/node_modules/*/index.ts 2>/dev/null

# 上下文模式扩展
grep -rn 'description:\s*"[A-Z]' /root/.pi/agent/npm/node_modules/context-mode/build/pi-extension.js 2>/dev/null
```

### 2. 查找未翻译的 SKILL.md 描述

```bash
# 用户技能
find /root/.pi/agent/skills -name SKILL.md -exec grep -l '^description:' {} \;

# npm 包技能
find /root/.pi/agent/npm/node_modules -name SKILL.md -exec sh -c 'grep -q "^description:" "$1" && ! grep -qP "[\x{4e00}-\x{9fff}]" "$1" && echo "⚠️  $1"' _ {} \;
```

### 3. 查找 pi 交互界面中未翻译的用户可见字符串

```bash
# 设置菜单选择器
PI=/usr/lib/node_modules/@earendil-works/pi-coding-agent
grep -n 'label:\s*"[A-Z]\|description:\s*"[A-Z]' "$PI/dist/modes/interactive/components/settings-selector.js"

# 会话选择器排序/筛选
sed -n '105,120p' "$PI/dist/modes/interactive/components/session-selector.js"

# 交互模式区段标题
sed -n '1050,1100p' "$PI/dist/modes/interactive/interactive-mode.js" | grep 'addLoadedSection'

# 登录对话框
sed -n '95,100p' "$PI/dist/modes/interactive/components/login-dialog.js"

# 资源配置
sed -n '11,16p' "$PI/dist/modes/interactive/components/config-selector.js"
```

### 4. 查找 context-mode 相关命令

```bash
PI=/usr/lib/node_modules/@earendil-works/pi-coding-agent
grep -n 'registerCommand' "$PI/dist/core/slash-commands.js"
grep -n 'registerCommand' /root/.pi/agent/npm/node_modules/pi-lens/index.ts
grep -n 'registerCommand' /root/.pi/agent/npm/node_modules/context-mode/build/pi-extension.js
```

### 查找原则

- `description: "..."`（双引号字符串）→ 替换为 `description: \`...\``（模板字面量）
- `description: \`...\``（模板字面量）中的英文→ 替换为中文
- `children:"..."`（HTML JSX 属性）→ 替换为 `children:"中文"`
- SKILL.md `description:` 块→ 保留 YAML 格式，替换文本内容
- 增量安全：脚本自动跳过已翻译的字符串（`if (content.includes(to)) continue;`）

## 验证

运行后重启 pi，输入 `/`、`/settings`、`/plannotator`、`/lens-toggle`、`/preview` 检查是否显示中文。
