---
name: pi-translate-zh
description: pi update 后重新翻译 TUI 中文界面：命令描述、设置菜单、子菜单、提示词描述、扩展命令、npm 插件文字、技能描述。用户说"翻译""中文化""汉化""翻译失效"时触发。
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

## 改进说明 (v11)

### v11 改进

- **修复覆盖率双算**：中英混合模板（如 `启用/禁用 Ctrl+P 循环的模型`）此前同时匹配英文/中文两个正则导致 total 虚高、pct 偏低。现改为先收集全部 description/label 模板再按内容分类，slash-commands 85%→100%、settings-selector 88%→100%
- **修复标识符误报**：纯标识符拼接模板（如 `${m.provider}/${m.id}`）去插值后无字母无中文，不再计入未翻译项（原报 interactive-mode 0/1 为误报）
- **新增未翻译条目清单**：覆盖率报告后直接列出仍为英文的 description/label 条目（每文件前 3 条），pi update 后可据此快速定位新增字符串
- **新增未匹配警告**：apply() 的未匹配条目（原文在当前版本不存在）不再仅在干跑模式输出，正常运行结束也汇总警告并附示例，提示可能已删除/移位/已被翻译
- **跳过节汇总**："跳过：不存在"逐行输出后增加一行汇总（N 节跳过：对应扩展未安装，安装后重跑脚本即可自动翻译）
- **新增 model-resolver 消息节**：`No models available. Check your installation or add models to models.json.` 自 interactive-mode.js 移位至 core/model-resolver.js（0.84 重构），已迁移翻译条目

### v10 改进

- **移除** `browser-automation` 和 `searx-search` 扩展引用（已被 `pi-web-toolkit` 替代；后者现名 `pi-web-search`）
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
| plan-mode todo 工具 + /todos 命令 | `plan-mode/todo.ts` | 2 条 |
| **plan-mode 扩展命令/标志** | `extensions/plan-mode/index.ts` | **5 条** |

## 自定义翻译

编辑 `patch-all-zh.mjs` 中的对应字符串即可。

## pi 更新后查找需要翻译的新文件

pi update 后可能新增或修改界面文字。以下排查步骤定位需要补充翻译的位置：

### 1. 查找未翻译的 description/label

```bash
# pi 核心命令
PI=/usr/lib/node_modules/@earendil-works/pi-coding-agent
grep -rn 'description:\s*"[A-Z]\|label:\s*"[A-Z]' "$PI/dist/" --include='*.js' | grep -v node_modules

# 扩展命令（agent/extensions/ 下各扩展入口）
grep -rn 'description:\s*"[A-Z]\|label:\s*"[A-Z]' /root/.pi/agent/extensions/*/index.ts 2>/dev/null
```

### 2. 查找未翻译的 SKILL.md 描述

```bash
# 用户技能
find /root/.pi/agent/skills -name SKILL.md -exec grep -l '^description:' {} \;

# 扩展技能
find /root/.pi/agent/extensions -name SKILL.md -exec sh -c 'grep -q "^description:" "$1" && ! grep -qP "[\x{4e00}-\x{9fff}]" "$1" && echo "⚠️  $1"' _ {} \;
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

### 4. 查找扩展命令注册

```bash
PI=/usr/lib/node_modules/@earendil-works/pi-coding-agent
grep -n 'registerCommand' "$PI/dist/core/slash-commands.js"
grep -rn 'commands: \|registerCommand\|name: "/' /root/.pi/agent/extensions/*/index.ts | head -50
```

### 查找原则

- `description: "..."`（双引号字符串）→ 替换为 `description: \`...\``（模板字面量）
- `description: \`...\``（模板字面量）中的英文→ 替换为中文
- `children:"..."`（HTML JSX 属性）→ 替换为 `children:"中文"`
- SKILL.md `description:` 块→ 保留 YAML 格式，替换文本内容
- 增量安全：脚本自动跳过已翻译的字符串（`if (content.includes(to)) continue;`）

## 验证

运行后重启 pi，输入 `/`、`/settings`，并检查扩展命令（`/voice`、`/memory`、`/plan`、`/link` 等）的 help 输出与提示词是否显示中文。
