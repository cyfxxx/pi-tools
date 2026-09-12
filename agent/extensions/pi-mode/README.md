# pi-mode — 模式切换扩展

> 模式切换扩展：支持在不同使用场景间快速切换配置，包括扩展、技能、系统提示词和思考级别。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.1 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 模式切换、配置管理 |
| 相关文档 | [modes.json](../../modes.json), [LESSONS-LEARNED.md](./LESSONS-LEARNED.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、配置项](#四配置项)
- [五、使用方法](#五使用方法)
- [六、自定义模式](#六自定义模式)
- [七、已知问题](#七已知问题)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

Pi 在不同使用场景下需要不同的配置：
- 完整功能 vs 轻量级
- 开发模式 vs 生产模式
- 不同的思考级别

### 1.2 设计理念

- **预设模式**：提供 full/light/quick 三种预设模式
- **自定义模式**：用户可根据需求创建自定义模式
- **快速切换**：支持命令行参数和运行时命令切换
- **渐进生效**：部分配置立即生效，部分需要重启

---

## 二、架构

### 2.1 系统架构图

```
用户请求 → /mode <name> → 更新 modes.json
    ↓
应用运行时配置（思考级别）
    ↓
提示重启（扩展/技能/提示词变更）
    ↓
重启后生效
```

### 2.2 核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 命令层 | `commands.ts` | 注册 /mode 命令及子命令 |
| 配置层 | `config.ts` | 模式配置加载、保存 |
| 应用层 | `apply.ts` | 运行时配置应用 |
| 类型层 | `types.ts` | 类型定义 |

---

## 三、功能

### 3.1 预设模式

| 模式 | 说明 | 扩展 | 技能 | 思考级别 |
|------|------|------|------|---------|
| `full` | 完整模式 | 全部 | 全部 | 默认 |
| `light` | 轻量模式 | 只保留搜索、plan-mode、pi-context | 只保留 pi-code-review | low |
| `quick` | 极简模式 | 无 | 无 | off |

### 3.2 命令清单

| 命令 | 说明 |
|------|------|
| `/mode` | 显示当前模式信息 |
| `/mode list` | 列出所有可用模式及状态 |
| `/mode <name>` | 切换到指定模式（扩展/技能/提示词变更需重启生效） |
| `/mode help` | 显示详细帮助信息 |

### 3.3 启动参数

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

### 3.4 扩展/技能前缀语法

| 前缀 | 含义 | 示例 |
|------|------|------|
| `!` | 排除 | `!pi-autopilot` 排除 pi-autopilot 扩展 |
| `!ALL` | 排除全部 | `!ALL` 禁用所有扩展/技能 |
| `+` | 强制包含 | `+skills/code-review/SKILL.md` 强制包含 |
| `-` | 强制排除 | `-skills/translate/SKILL.md` 强制排除 |

---

## 四、配置项

### 4.1 配置文件

位置：`~/.pi/agent/modes.json`

### 4.2 Schema

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
      "appendSystemPrompt": "~/.pi/agent/extensions/pi-mode/prompts/append.md",
      "thinking": "low"
    }
  }
}
```

### 4.3 字段说明

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

---

## 五、使用方法

### 5.1 查看当前模式

```bash
/mode
```

输出示例：
```
当前模式: full
描述: 完整模式 - 所有扩展和技能可用
默认模式: full

使用 /mode <name> 切换模式，/mode list 查看所有模式，/mode help 查看帮助
```

### 5.2 列出所有模式

```bash
/mode list
```

输出示例：
```
可用模式:

  full (当前): 完整模式 - 所有扩展和技能可用
    覆盖: 0 扩展, 0 技能

  light: 轻量模式 - 只保留搜索、计划模式和基础工具
    覆盖: 3 扩展, 1 技能 [需重启]

  quick: 极简模式 - 只保留内置工具，无扩展无技能
    覆盖: 0 扩展, 0 技能 [需重启]

使用 /mode <name> 切换模式
```

### 5.3 切换模式

```bash
/mode light        # 切换到轻量模式
/mode full         # 切换回完整模式
/mode quick        # 切换到极简模式
```

### 5.4 启动时指定模式

```bash
pi --mode light     # 以轻量模式启动
pi -m quick         # 以极简模式启动
```

---

## 六、自定义模式

### 6.1 创建自定义模式

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
      "appendSystemPrompt": "~/.pi/agent/extensions/pi-mode/prompts/coding-append.md",
      "thinking": "high"
    }
  }
}
```

### 6.2 提示词文件

模式的追加提示词文件放在 `~/.pi/agent/extensions/pi-mode/prompts/` 目录下：

- `light-append.md` - light 模式追加提示词
- `quick-append.md` - quick 模式追加提示词

### 6.3 工作原理

**启动时**：
1. `pi-wrapper.sh` 解析 `--mode` 参数
2. 读取 `modes.json` 获取模式配置
3. 翻译为 CLI 标志（`--no-extensions`/`--no-skills`/`--append-system-prompt` 等）
4. 设置环境变量 `PI_AGENT_MODE` 供扩展使用

**运行时**：
1. `/mode <name>` 更新 `modes.json` 中的 `current` 字段
2. 应用运行时可变配置（思考级别）
3. 扩展/技能/提示词变更提示用户重启

---

## 七、已知问题

- **扩展/技能/系统提示词变更需要重启 pi 才能生效**
- **思考级别可立即生效**
- **启动时非 full 模式会在 TUI 顶部显示模式提示**
- **`!ALL` 会禁用所有扩展/技能，请谨慎使用**

---

## 八、测试

### 8.1 运行测试

```bash
cd agent/extensions/pi-mode
npm install
npx vitest run
```

### 8.2 测试覆盖

- 配置加载和保存
- 模式切换逻辑
- 命令注册和处理
- 运行时配置应用

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.1 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |
| 2026-09-XX | v1.0 | 初始版本，实现模式切换功能 |