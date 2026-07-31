# Pi 扩展深度定制参考

> 扩展 API 不够用时，如何安全地利用 SDK 做更深层定制。

## 一、背景：扩展 API 与 SDK 的关系

Pi 的扩展系统有两层能力来源：

| 来源 | 入口 | 说明 |
|------|------|------|
| **扩展 API** | `pi.on()` / `pi.registerTool()` / `pi.registerCommand()` | Pi 进程内安全发起的"插件接口"，生命周期和权限受控 |
| **SDK** | `@earendil-works/pi-agent-core` / `@earendil-works/pi-coding-agent` | Pi 核心能力的库导出，可在扩展中直接 import |

**为什么可以结合：** 扩展加载器（`loader.js`）已内置 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui`、`typebox` 作为虚拟模块。扩展代码可以直接 `import` 它们，无需额外安装。

```typescript
// 扩展里可以直接写（不报错，不需要 npm install）：
import { estimateTokens, createBashToolDefinition, SessionManager } 
  from "@earendil-works/pi-coding-agent"
```

---

## 二、深度定制总览

```
浅（安全）                   深（有风险）
┌──────────────────────────────────────────────┐
│  扩展 API 已有                 SDK 可达         │
│                                              │
│  pi.on("context")              import + cast    │
│  pi.registerTool()             import 工厂函数    │
│  pi.registerCommand()          import 纯工具函数  │
│  pi.registerProvider()         globalThis 共享   │
│  ctx.ui.*                                          │
│  ctx.sessionManager (只读)     突破只读限制       │
│  ctx.compact()                 compact() 全参数   │
└──────────────────────────────────────────────┘
```

| 层级 | 能做 | 安全 | 需要 SDK |
|------|------|------|---------|
| 事件拦截 | 读写 prompt/消息/工具参数和结果 | ✅ | 不需要 |
| 纯函数增强 | token 估算/裁剪/压缩/串化 | ✅ | 需要 |
| 工具工厂 | 创建自定义版内置工具 | ✅ | 需要 |
| 类型突破 | 调用 SessionManager 写方法 | ⚠️ | 需要 |
| 全局共享 | 扩展间共用状态 | ⚠️ | 不需要 |
| 新 Provider | 运行时添加模型供应商 | ✅ | 不需要 |

---

## 三、方案详解

### 方案 A：导入 SDK 纯函数增强扩展（✅ 安全）

**适用场景：** 扩展需要在事件处理中做更精细的计算，比如裁剪 context、估算 token、做压缩。

**可用函数清单（从 `@earendil-works/pi-coding-agent` 导出）：**

| 函数 | 用途 |
|------|------|
| `estimateTokens(message)` | 估算单条消息 token 数（字符/4 保守估算） |
| `estimateContextTokens(messages)` | 用最后一条 usage 计算总 context token，无则回退逐条估算 |
| `calculateContextTokens(usage)` | 从 usage 计算 context token（优先 totalTokens） |
| `compact(preparation, model, ...)` | 执行压缩（全参数控制） |
| `shouldCompact(contextTokens, contextWindow, settings)` | 判断是否需要压缩 |
| `prepareBranchEntries(entries, tokenBudget)` | 预计算分支摘要条目 |
| `serializeConversation(messages)` | 将消息串化为文本 |
| `findCutPoint(entries, startIndex, endIndex, keepRecentTokens)` | 找到截断点 |
| `findTurnStartIndex(entries, entryIndex, startIndex)` | 找到最近 turn 起点 |
| `convertToLlm(messages)` | AgentMessage → LLM Message |
| `parseFrontmatter(text)` | 解析 frontmatter |
| `parseSessionEntries(content)` | 解析 session 条目 |
| `getLatestCompactionEntry(entries)` | 取最近一份 compaction 摘要 |

**示例：按实际 token 数做 context 裁剪**

```typescript
import { estimateContextTokens, findCutPoint } from "@earendil-works/pi-coding-agent"

pi.on("context", (event, ctx) => {
  const { tokens } = estimateContextTokens(event.messages)
  const limit = 80_000  // 自定义阈值
  if (tokens > limit) {
    const cutIndex = findCutPoint(event.messages, 0, event.messages.length, 20_000)
    return { messages: event.messages.slice(cutIndex.firstKeptEntryIndex) }
  }
})
```

**限制：** 这些是纯函数，只能计算不能改变 Pi 内部状态。

---

### 方案 B：用 SDK 工厂函数创建自定义工具（✅ 安全）

**适用场景：** 要在内置工具（bash/read/write/edit/grep/find/ls）基础上加安全校验、日志、拦截。

**可用工厂函数：**

```typescript
import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent"
```

**示例：安全版 bash 工具（阻止危险命令）**

```typescript
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent"

const bashDef = createBashToolDefinition({ timeout: 30_000 })

pi.registerTool({
  ...bashDef,
  name: "safe_bash",
  execute: async (id, params, signal, onUpdate, ctx) => {
    const { command } = params
    const blocked = ["rm -rf", "dd if=", ":(){ :|:& };:", "> /dev/sda"]
    if (blocked.some(b => command.includes(b))) {
      return {
        content: [{ type: "text", text: `Blocked: command matched deny pattern.` }],
        details: { blocked: true },
        isError: true,
      }
    }
    return bashDef.execute(id, params, signal, onUpdate, ctx)
  },
})
```

**限制：**
- 只能创建**新**工具（`registerTool` 不能覆盖同名），不能改 Pi 内置的 `bash`/`read`/`write` 等
- TypeBox schema 必须与工厂函数返回的一致

---

### 方案 C：类型转换突破只读限制（⚠️ 有风险）

**适用场景：** 需要在扩展中写 session 元数据、合并 session、重命名等——扩展 API 没暴露写方法时。

**原理：** `ctx.sessionManager` 运行时是完整的 `SessionManager` 实例，但类型是只读的 `ReadonlySessionManager`（`Pick<SessionManager, 若干只读方法>`）。通过类型转换可以绕过。

```typescript
import type { SessionManager } from "@earendil-works/pi-agent-core"

pi.on("agent_end", (event, ctx) => {
  const mgr = ctx.sessionManager as unknown as SessionManager
  mgr.setSessionName("auto-named-session")
  mgr.setLabel(entryId, "reviewed")
  mgr.merge(otherSession) // 合并另一个 session
  mgr.addEntry(customEntry) // 添加自定义条目
})
```

**`SessionManager` 可额外调用的写方法（`ReadonlySessionManager` 没有的）：**

| 方法 | 用途 |
|------|------|
| `setSessionName(name)` | 设置 session 名称 |
| `setLabel(entryId, label)` | 给条目打标签 |
| `addEntry(entry)` | 添加条目 |
| `addEntries(entries)` | 批量添加 |
| `removeEntry(entryId)` | 删除条目 |
| `updateEntry(entryId, entry)` | 更新条目 |
| `setBranch(entryId, branch)` | 设置分支 |
| `merge(other)` | 合并 session |
| `compact()` | 主动压缩 |
| `save()` | 持久化 |

**⚠️ 风险：**
- **版本耦合：** `ReadonlySessionManager` 的 `Pick` 列表随版本变化，Cast 后的方法名可能在不同版本间消失或改名
- **状态不一致：** 绕过扩展 API 直接修改 session，Pi 内部可能没收到通知，导致 UI 不同步
- **调试困难：** Pi 不保证这些内部方法的稳定性，出问题不兼容

---

### 方案 D：命令上下文深入（基本安全）

**适用场景：** `/foo` 命令需要在 session 间切换、fork、发送消息。

**不同于普通事件上下文的地方：**

`ExtensionCommandContext`（给 `registerCommand` handler 使用）比 `ExtensionContext` 多出：

```typescript
// 只有命令 handler 有：
ctx.newSession(options)     // 创建新 session
ctx.fork(entryId, options)  // 分叉 session
ctx.navigateTree(targetId)  // 导航到 session 树节点
ctx.switchSession(path)     // 切换到其他 session 文件
ctx.waitForIdle()           // 等待 agent 空闲
ctx.reload()                // 重新加载扩展/技能/配置
```

**`withSession()` 回调更进一步（`ReplacedSessionContext`）：**

```typescript
pi.registerCommand({
  name: "snapshot",
  description: "创建快照并切回",
}, async (ctx) => {
  await ctx.fork(ctx.getLeafId(), {
    withSession: async (newCtx) => {
      // 此时 newCtx 绑定到新 fork 的 session
      await newCtx.sendUserMessage(
        "请总结当前进展并保存到笔记"
      )
    }
  })
})
```

**`sendUserMessage` 的 `deliverAs` 参数：**

| 值 | 效果 |
|----|------|
| `"steer"` | 插入为 steering 消息，在当前 turn 执行完后立即处理 |
| `"followUp"` | 插入为 follow-up 消息，在 agent 自然结束后处理 |
| `"nextTurn"` | 下一个用户输入时处理 |

---

### 方案 E：globalThis 跨扩展状态共享（⚠️ 有风险）

**适用场景：** 两个扩展需要共享内存状态，不想通过文件系统或 `pi.events` 的字符串频道。

```typescript
// 扩展 A：写
globalThis.__pi_shared_state ??= {}
globalThis.__pi_shared_state.lastSearchResults = results

// 扩展 B：读
const results = globalThis.__pi_shared_state?.lastSearchResults
```

**⚠️ 风险：**
- 命名冲突（建议用 `__pi_` 前缀）
- 无类型安全
- 扩展卸载时不会自动清理

**替代方案：** `pi.events` EventBus（类型安全更差，但不会污染全局作用域）

```typescript
// 扩展 A
pi.events.on("my-channel", handler)

// 扩展 B
pi.events.emit("my-channel", data)
```

---

### 方案 F：自定义 Provider（✅ 安全）

**适用场景：** 添加非标准 API 兼容的模型供应商，需要自定义 baseUrl、HTTP headers、认证方式、流式解析。不需要 SDK。

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "https://my-api.example.com/v1",
  models: [
    { id: "my-model", maxTokens: 128_000, contextWindow: 128_000 }
  ],
  login: async (ctx) => {
    const key = await ctx.ui.input({ prompt: "API Key:" })
    return { apiKey: key }
  }
})
```

参见内置的 `registerProvider` 类型定义和 Pi 的 `ModelRuntime`。

---

## 四、不能做什么

以下操作即使结合 SDK 也无法在扩展中完成：

| 操作 | 原因 |
|------|------|
| 改 `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `prepareNextTurn` | 这些是 `createAgentSession()` 的配置参数，运行时已固定，外部无法注入 |
| 改 agent loop 的 retry/compact/continue 逻辑 | agent loop 内部硬编码 |
| 改扩展加载机制 | 加载器在扩展运行前已完成 |
| 改会话文件格式 | SessionManager 的序列化/反序列化硬编码 |
| 改终端渲染框架 | ink/reconciler 在扩展之外 |
| 替换 Pi 内置工具（bash/read/write） | `registerTool` 不能覆盖已有工具名 |
| 访问或修改用户输入队列 | steering/follow-up 队列只读 |

**要改这些，必须 fork Pi 源码。**

---

## 五、决策树：应该用哪个方案

```
你想做什么？
│
├─ 拦截/修改 LLM 看到的 prompt 或消息？
│   └─ 扩展 API 事件：before_agent_start / context / message_end → 不需要 SDK
│
├─ 拦截/修改工具调用或结果？
│   └─ 扩展 API 事件：tool_call / tool_result → 不需要 SDK
│
├─ 注册新工具？
│   ├─ 完全自定义 → pi.registerTool() → 不需要 SDK
│   └─ 基于内置工具加安全层 → 方案 B（createBashToolDefinition + registerTool）
│
├─ 做数据计算（token 估算/裁剪/压缩）？
│   └─ 方案 A（import estimateTokens / compact 等纯函数）
│
├─ 注册新命令 / 快捷键 / provider？
│   └─ 扩展 API：registerCommand / registerShortcut / registerProvider → 不需要 SDK
│
├─ 在命令中切换/分叉 session？
│   └─ 方案 D（registerCommand 的 ExtensionCommandContext）
│
├─ 写 session 元数据 / 合并 session？
│   ├─ 先尝试 ctx.compact() / APPEND_SYSTEM.md / agent.md 等配置手段
│   └─ 还不够 → 方案 C（类型转换，有风险）
│
├─ 扩展间共享状态？
│   ├─ 优先用 pi.events EventBus
│   └─ 需要大量数据传输 → 方案 E（globalThis，有风险）
│
└─ 以上都不够？
    └─ 考虑 fork Pi 源码或构建独立 SDK 应用
```

---

## 六、总结与注意事项

### 优先顺序

1. **能用配置解决的**：`settings.json` / `APPEND_SYSTEM.md` / `agent .md` 优先
2. **能用扩展 API 解决的**：29 个事件 + `registerTool` + `registerCommand` 第二优先
3. **需要 SDK 纯函数**：方案 A / B（安全，推荐）
4. **需要突破限制**：方案 C / E（有风险，尽量少用）

### 注意事项

- **SDK 版本锁定：** `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-coding-agent` 随 Pi 更新。如果导入的函数签名变了，扩展会在运行时 break。建议在 `CHANGELOG.md` 中记录依赖的 Pi 版本。
- **类型安全优先：** 能用 `import type` 就别 cast `as any`。方案 C 的 cast 应该集中在一个文件里，方便排查。
- **测试：** 用到 SDK 导入的扩展要在 Pi 版本升级后做回归测试。
- **热重载行为：** 扩展通过 `ctx.reload()` 重载时，`globalThis` 上残留的状态不会自动清理，方案 E 需要注意。
- **不要依赖内部 API：** 方案 C 突破的类型方法不被 Pi 官方保障稳定，升级后出问题先自查是否 cast 所致。
