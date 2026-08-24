---
name: pi-translate-zh
description: pi update 后重新翻译 TUI 中文界面：命令描述、设置菜单、子菜单、提示词描述、扩展命令、npm 插件文字、技能描述。用户说"翻译""中文化""汉化""翻译失效"时触发。。不适用：pi 升级前无需预防性执行；仅翻译扩展内单个文件时先确认 patch-all-zh.mjs 已覆盖。
version: v1.1
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

> 改进说明与历史机制（v11/v10/v8、自动路径检测、备份机制、翻译覆盖率统计）见 `references/CHANGELOG.md`。

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
| plan-mode todo 工具 + /plan todos 命令 | `plan-mode/todo.ts` | 2 条 |
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

---

## 使用后改进（必做）

任务收尾时清点：执行过程与本文步骤/路径/结论的偏差。有 → 追加一条到 `improvements.md`（证据导向：命令、路径、现象，不直接改正文）。未合并条目 ≥3 条或用户要求时，合并进正文并清日志。机制全文见 `agent/skills/SKILLS-MAINTENANCE.md`。

