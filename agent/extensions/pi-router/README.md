# pi-router

Hook `before_agent_start` 注入主动路由策略 + 实时 token 预算。

## 机制

- 每轮 LLM 调用前，在 system prompt 尾部追加 `## Proactive Delegation` 章节
- 包含决策表（何时用 scout / parallel / chain）
- 包含实时 context 占用率 `[Context: 45K/128K used (35%)]`

## 依赖

- 无额外 npm 依赖
- 需要 `subagent` 扩展和 agent 定义（scout/planner/worker/reviewer）配合生效
