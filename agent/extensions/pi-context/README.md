# pi-context

6 个事件处理器，减少不必要 token 消耗，全程零用户感知。

## Handler 清单

| # | Hook | 作用 | 省 token |
|---|------|------|----------|
| R2 | `context` | 只保留最新一份 compactionSummary | 500-1500/turn |
| R3 | `context` | 旧 turn（>2 轮）的 thinking 块剪枝 | 10-50% 旧消息 |
| R4 | `tool_result` | bash/read 输出 >5000 字节时用 SDK 截断 | 50-80% 工具结果 |

## 注意事项

- R3 负责 thinking 剪枝：保留最近 2 轮 thinking 供推理，旧轮统一剥离。曾在 `message_end` 无条件剥离 thinking（R1），与 R3 矛盾且会丢失最近推理，已移除。
- R4 只在输出 >5000 字节时生效，短输出不做处理；bash 用 `truncateTail`（保留末尾错误/结果），read 用 `truncateHead`（保留开头），并保留原始 details。
