# pi-intervention — 干预捕获扩展

> 用户中途干预（abort）是价值密度最高的信号。本扩展在程序侧捕获中断快照，并与用户的 corrective prompt 自动关联，为意图差分析与未来 LoRA 训练数据提供底座。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 更新日期 | 2026-09-12 |
| 适用范围 | 用户干预捕获、意图分析 |
| 相关文档 | [VISION.md](../../../../docs/design/VISION.md), [ROADMAP.md](../../../../docs/design/SELF-OPTIMIZING-ROADMAP.md) |

---

## 目录

- [一、概述](#一概述)
- [二、架构](#二架构)
- [三、功能](#三功能)
- [四、数据格式](#四数据格式)
- [五、事件流](#五事件流)
- [六、命令](#六命令)
- [七、配置项](#七配置项)
- [八、测试](#八测试)
- [九、更新记录](#九更新记录)

---

## 一、概述

### 1.1 解决的问题

用户在使用 Pi 过程中可能会中途干预（abort），这些干预信号是理解用户意图和改进系统的重要数据源。本扩展旨在：

- 捕获用户中断快照
- 自动关联 corrective prompt（用户在中断后的修正指令）
- 为意图差分析和 LoRA 训练数据提供结构化数据

### 1.2 设计理念

- **零注入**：不向 system prompt 注入任何内容，保持缓存友好
- **静默容错**：所有 handler 静默处理错误，不影响主流程
- **结构化存储**：为 LoRA 训练数据铺垫约束（时间戳/环境/触发条件/结果）

---

## 二、架构

### 2.1 系统架构图

```
用户干预 (abort)
  ↓
[1] agent_end 事件触发
  ↓
[2] 检查 stopReason === "aborted"
  ↓
[3] 生成快照数据
  ↓
[4] 写入 memory/interventions.jsonl
  ↓
[5] 与 corrective prompt 关联（15min 窗口）
```

### 2.2 核心组件

| 组件 | 功能 |
|------|------|
| 事件处理器 | 监听 before_agent_start、tool_execution_start、input、agent_end 事件 |
| 快照生成器 | 生成干预快照数据，包含上下文信息 |
| 关联引擎 | 将 abort 事件与后续 corrective prompt 关联 |
| 存储管理 | 管理 interventions.jsonl 文件，实现淘汰机制 |

---

## 三、功能

### 3.1 核心功能

| 功能 | 说明 |
|------|------|
| 干预快照 | 捕获用户中断时的完整上下文 |
| corrective 关联 | 将 abort 与 15 分钟内的修正指令关联 |
| 轨迹追踪 | 记录本轮工具调用轨迹（≤20 条） |
| steering 捕获 | 捕获用户运行中的纠正（≤3 条） |

### 3.2 命令

| 命令 | 说明 |
|------|------|
| `/intervention recent [N]` | 查看最近 N 条快照（默认 5） |
| `/intervention stats` | 查看统计信息（总数/关联率/占比/近 7 天） |
| `/intervention help` | 显示帮助信息 |

---

## 四、数据格式

### 4.1 数据文件

- **路径**：`memory/interventions.jsonl`（git 忽略）
- **上限**：2000 条，超出淘汰最旧

### 4.2 字段说明

每行 JSON 包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识 |
| `ts` | number | 时间戳 |
| `type` | string | 固定值 "abort" |
| `prompt` | string | 用户输入（≤800 字符） |
| `tools[]` | array | 工具调用列表 |
| `lastTool` | object | 最后一个工具调用（name, brief） |
| `tail` | string | 最后一条 assistant 消息（≤400 字符） |
| `steering[]` | array | 用户纠正（≤3 条 ×300 字符） |
| `correctivePrompt` | string | 关联的修正指令 |
| `correctedAt` | number | 修正时间戳 |
| `env` | object | 环境信息（platform, termux） |
| `cwd` | string | 当前工作目录 |

### 4.3 LoRA 训练数据约束

结构化字段为 LoRA 铺垫约束（VISION §6）：
- 时间戳
- 环境信息
- 触发条件
- 结果

这些字段可直接作为训练集使用。

---

## 五、事件流

### 5.1 事件处理

| 事件 | 行为 |
|------|------|
| `before_agent_start` | 记录意图；若上次 abort 在 15min 窗内 → 回填 correctivePrompt |
| `tool_execution_start` | 追踪本轮工具轨迹（≤20 条，参数摘要 ≤120 字符） |
| `input` | 捕获 steer 纠正（运行中用户插入，streamingBehavior==="steer"；≤3 条 ×300 字符） |
| `agent_end` | 最后一条 assistant 消息 `stopReason==="aborted"` 时落盘快照 |

### 5.2 设计特点

- **零注入**：不向 system prompt 注入任何内容
- **缓存友好**：不破坏 prompt 缓存
- **静默容错**：所有 handler 静默处理错误
- **截断存储**：prompt/tail/steering 截断存储，避免数据膨胀

---

## 六、命令

### 6.1 查看最近快照

```bash
/intervention recent      # 查看最近 5 条
/intervention recent 10   # 查看最近 10 条
```

### 6.2 查看统计信息

```bash
/intervention stats
```

输出示例：
```
干预统计:
  总数: 150
  corrective 关联率: 65%
  steering 占比: 12%
  近 7 天: 23
```

### 6.3 查看帮助

```bash
/intervention help
```

---

## 七、配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `PI_INTERVENTIONS_FILE` | `memory/interventions.jsonl` | 覆盖数据文件路径（测试用） |
| `PI_HOME` | `~/.pi` | 覆盖仓库根 |

### 7.1 配置方式

设置环境变量：

```bash
export PI_INTERVENTIONS_FILE=/tmp/test-interventions.jsonl
export PI_HOME=/tmp/test-pi
```

---

## 八、测试

### 8.1 测试位置

测试用例位于 `extensions/pi-web-search/tests/extensions.test.ts` 中的 pi-intervention 块。

### 8.2 测试内容

- 注册面断言
- 快照落盘功能测试
- corrective 关联功能测试

### 8.3 运行测试

```bash
cd agent/extensions/pi-web-search
../../node_modules/vitest/vitest.mjs run tests/extensions.test.ts
```

### 8.4 测试特点

- 使用临时目录，不影响生产数据
- 无 LLM 依赖，确定性测试
- 覆盖核心功能路径

---

## 九、更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-09-12 | v1.0 | 按照文档模板重新组织结构，添加元信息、目录导航、章节编号 |