# pi-context

上下文管理扩展：8 个事件处理器 + 1 个诊断命令，减少不必要 token 消耗，全程零用户感知。

## Handler 清单

| # | Hook | 作用 | 省 token |
|---|------|------|----------|
| 1 | `context` | 过滤 usage-diag 诊断消息（仅展示、不进 LLM 上下文）+ 工具输出分层擦除 + 只保留最新一份 compactionSummary + thinking 按 token 预算剪枝 | 数千/turn |
| 2 | `tool_result` | bash/read 输出 >5KB 截断（bash 保留尾部、read 保留头部），其他工具 >20KB 兜底截断 | 50-80% 工具结果 |
| 3 | `tool_result` | 缓存命中统计（聚合 cacheRead/cacheWrite，仅记录，不注入上下文） | — |
| 4 | `turn_end` | 每轮用量记录（input/缓存/输出，写入 usage-diag 日志） | — |
| 5 | `agent_settled` | 按窗口比例自动压缩判定 + `ctx.compact()`（判定放 run 完全 settled 后——agent_end 时内核可能重试/续跑，compact 会 abort 杀掉重试轮；agent_settled 语义为无重试/压缩/排队续跑） | 大窗口会话持续膨胀 |
| 6 | `session_compact` | 压缩完成后自动继续（AutoContinueGate，注入继续指令并 triggerTurn 启动新一轮） | 免手动继续 |
| 7 | `session_start` | 会话恢复时立即检查压缩阈值（resume 大会话避免首轮全量重发浪费） | 首轮全量重发 |
| 8 | `before_agent_start` | 注入主动委托建议（delegationAdvice）+ 档位化压力提示 + 执行效率指令（EFFICIENCY_ADVICE） | 上下文利用率 |

## 命令

| 命令 | 说明 |
|------|------|
| `/usage-diag` | 显示会话 LLM 用量诊断：每轮 input/缓存/输出汇总 + prune 擦除量 + 压缩触发记录（数据存 `~/.pi/agent/.usage-diag.jsonl`，仅展示不进 LLM 上下文） |

## 关键机制

- **自动压缩**：按窗口比例触发（>256K 窗口 40% / ≤256K 窗口 85%，见 `lib/auto-compact.ts`）；判定在 `agent_settled`（`ctx.compact()` 会 abort 当前 agent 且不 await 完成；agent_end 时内核可能仍重试，agent_settled 语义为 run 完全 settled 无重试/排队续跑），`recordAutoCompact`/`markCompact` 移入 `onComplete`——压缩成功后才记账/起 180s 冷却，失败不进入 cooldown、下一轮可重试；压缩完成由 `session_compact` 事件通知；`AutoContinueGate` 在压缩完成后自动注入继续指令（`triggerTurn: true` 启动新一轮），180s 冷却防递归。resume 恢复大会话时 `session_start` 立即压缩（此时无 agent 运行，abort 是 no-op，且 gate 未 arm 不会自动继续）。
- **分层擦除**（`lib/prune.ts`）：最近 2 轮 + 40K token 保护带内保留，更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构）；预计回收 ≥20K 才应用；判定确定性、擦除点单调后移，缓存前缀稳定。
- **thinking 剪枝**（token 预算规则）：保留最近 16K token 的 thinking（`DEFAULT_KEEP_THINKING_TOKENS = 16000`），预算耗尽处及更早的全部删除。早期"保留最近 2 轮"的数量规则已废弃——max 推理级别下单轮 reasoning 可达 5-10K，轮数上限不可控。
- **工具输出截断**（R4）：写入时截断——bash/read 5KB（bash 用 `truncateTail` 保留尾部错误/结果，read 用 `truncateHead` 保留开头，并保留原始 details），其他工具 20KB 兜底（防止未来新工具输出失控直达上下文）。
- **执行效率注入**（`EFFICIENCY_ADVICE`，静态缓存友好）：要求模型一轮内批量发出独立工具调用（内核已支持 parallel batch）、非终轮不写解释文本、todo/plan 摘要请求时例外。
- **压力提示按档位**：基于 auto-compact 阈值比例注入固定文案（阈值内 <75% 不注入、≥75% 注入委托建议文案、≥90% 注入保存决策文案）；档位跳变才改变 system prompt，无压力时与 pi 原生完全一致 → 消息历史缓存前缀稳定。
- **真实用量校准（2026-08 审计）**：`before_agent_start` 用 `ctx.getContextUsage()` 的真实 tokens 调 `setUsedTokens` 覆盖共享库上报值（recordToolUsage 只统计工具输出，与真实上下文用量口径不一致）——plan-mode 等共享 context-budget 的消费者压力提示随之准确
- **缓存友好**：所有变换均为确定性（判定只依赖消息内容）；system prompt 注入不含时间戳与精确数值。
- **compactionSummary 去重**（R2）：context 阶段只保留最新一份，省 500-1500 token/turn。

## 注意

- 扩展的异步回调不得使用捕获的 ctx（session 替换后 stale ctx 抛错），需先取值。
- 压缩失败不致命：pi 内置窗口 − reserveTokens 兜底仍在（对 1M 窗口模型约 96.7 万，故本扩展的按比例阈值必不可少）。
