# pi-mode

模式切换扩展：支持在不同使用场景间快速切换配置，包括扩展、技能、系统提示词和思考级别。

## 概述

pi-mode 提供三种预设模式，用户也可以自定义模式：

| 模式 | 说明 | 扩展 | 技能 | 思考级别 |
|------|------|------|------|---------|
| `full` | 完整模式 | 全部 | 全部 | 默认 |
| `light` | 轻量模式 | 只保留搜索、plan-mode、pi-context | 只保留 pi-code-review | low |
| `quick` | 极简模式 | 无 | 无 | off |

## 命令

| 命令 | 说明 |
|------|------|
| `/mode` | 显示当前模式信息 |
| `/mode list` | 列出所有可用模式及状态 |
| `/mode <name>` | 切换到指定模式（扩展/技能/提示词变更需重启生效） |
| `/mode help` | 显示详细帮助信息 |

## 启动参数

```bash
pi --mode <name>    # 启动时指定模式
pi -m <name>        # 简写形式
```

示例：
```bash
pi --mode light     # 以轻量模式启动
pi -m quick         # 以极简模式启动
pi --mode full      # 以完整模式启动（默认）
```

## 配置文件

位置：`~/.pi/agent/modes.json`

### Schema

```json
{
  "default": "full",
  "current": "full",
  "modes": {
    "<mode-name>": {
      "description": "模式描述",
      "extensions": ["!ext1", "+ext2", "-ext3"],
      "skills": ["+skill1", "-skill2"],
      "systemPrompt": null,
      "appendSystemPrompt": "~/.pi/agent/modes/prompts/append.md",
      "thinking": "low"
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `default` | string | 默认模式名称 |
| `current` | string | 当前活跃模式（运行时自动更新） |
| `modes.<name>.description` | string | 模式描述 |
| `modes.<name>.extensions` | string[] | 扩展覆盖列表 |
| `modes.<name>.skills` | string[] | 技能覆盖列表 |
| `modes.<name>.systemPrompt` | string\|null | 系统提示词文件路径（null=使用默认） |
| `modes.<name>.appendSystemPrompt` | string\|null | 追加系统提示词文件路径（null=使用默认） |
| `modes.<name>.thinking` | string\|null | 思考级别（off/minimal/low/medium/high/xhigh/max） |

### 扩展/技能前缀语法

| 前缀 | 含义 | 示例 |
|------|------|------|
| `!` | 排除 | `!pi-autopilot` 排除 pi-autopilot 扩展 |
| `!ALL` | 排除全部 | `!ALL` 禁用所有扩展/技能 |
| `+` | 强制包含 | `+skills/code-review/SKILL.md` 强制包含 |
| `-` | 强制排除 | `-skills/translate/SKILL.md` 强制排除 |

## 自定义模式

编辑 `~/.pi/agent/modes.json`，在 `modes` 对象中添加新条目：

```json
{
  "default": "full",
  "current": "full",
  "modes": {
    "full": { ... },
    "light": { ... },
    "quick": { ... },
    "coding": {
      "description": "编码模式 - 关闭搜索和浏览器",
      "extensions": ["!pi-web-search", "!pi-browser"],
      "skills": ["+skills/pi-code-review/SKILL.md"],
      "systemPrompt": null,
      "appendSystemPrompt": "~/.pi/agent/modes/prompts/coding-append.md",
      "thinking": "high"
    }
  }
}
```

## 提示词文件

模式的追加提示词文件放在 `~/.pi/agent/modes/prompts/` 目录下：

- `light-append.md` - light 模式追加提示词
- `quick-append.md` - quick 模式追加提示词

## 工作原理

### 启动时

1. `pi-wrapper.sh` 解析 `--mode` 参数
2. 读取 `modes.json` 获取模式配置
3. 翻译为 CLI 标志（`--no-extensions`/`--no-skills`/`--append-system-prompt` 等）
4. 设置环境变量 `PI_AGENT_MODE` 供扩展使用

### 运行时

1. `/mode <name>` 更新 `modes.json` 中的 `current` 字段
2. 应用运行时可变配置（思考级别）
3. 扩展/技能/提示词变更提示用户重启

## 注意事项

- 扩展/技能/系统提示词变更需要重启 pi 才能生效
- 思考级别可立即生效
- 启动时非 full 模式会在 TUI 顶部显示模式提示
- `!ALL` 会禁用所有扩展/技能，请谨慎使用
