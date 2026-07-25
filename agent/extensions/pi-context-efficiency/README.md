# pi-context-efficiency

6 个事件处理器，减少不必要 token 消耗，全程零用户感知。

## Handler 清单

| # | Hook | 作用 | 省 token |
|---|------|------|----------|
| R1 | `message_end` | 剥离 assistant 的 thinking 块，不存入会话历史 | 50-80% 每轮 assistant 消息 |
| R2 | `context` | 只保留最新一份 compactionSummary | 500-1500/turn |
| R3 | `context` | 旧 turn（>2 轮）的 thinking 块剪枝 | 10-50% 旧消息 |
| R4 | `tool_result` | bash/read 输出 >5000 字符时截断 | 50-80% 工具结果 |
| R5 | pi-router 增强 | 注入 token 预算，引导 delegate | 间接 |
| R6 | `input` | /ping 免 LLM 响应 | 单次完全省掉 |

## 注意事项

- R1 不影响当前轮显示，只阻止 thinking 进入后续 context
- R4 只在输出 >5000 字符时生效，短输出不做处理

## 依赖

- 无额外 npm 依赖
- R5 功能在 pi-router 扩展中实现
