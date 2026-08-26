# pi-intervention — 干预捕获扩展

VISION P1（`docs/VISION.md` §4 度量体系）/ ROADMAP 4.1。用户中途干预（abort）是价值密度最高的信号：本扩展在程序侧捕获中断快照，并与用户的 corrective prompt（关联窗 15min 内的下一条意图）自动关联，为意图差分析与未来 LoRA 训练数据提供底座。

## 数据

- 落盘 `memory/interventions.jsonl`（git 忽略；上限 2000 条，超出淘汰最旧）。
- 每行字段：`id / ts / type:"abort" / prompt / tools[] / lastTool{name,brief} / tail / steering[] / correctivePrompt / correctedAt / env{platform,termux} / cwd`。
- 结构化字段为 LoRA 铺垫约束（VISION §6）：时间戳/环境/触发条件/结果可直接作训练集。

## 事件流（零注入，缓存友好）

| 事件 | 行为 |
|---|---|
| before_agent_start | 记录意图；若上次 abort 在 15min 窗内 → 回填 correctivePrompt |
| tool_execution_start | 追踪本轮工具轨迹（≤20 条，参数摘要 ≤120 字符） |
| input | 捕获 steer 纠正（运行中用户插入，streamingBehavior==="steer"；≤3 条 ×300 字符） |
| agent_end | 最后一条 assistant 消息 `stopReason==="aborted"` 时落盘快照 |

所有 handler 静默容错；prompt/tail/steering 截断存储（800/400/300），不注入 system prompt。

## 命令

- `/intervention recent [N]` — 最近 N 条快照（默认 5）
- `/intervention stats` — 总数 / corrective 关联率 / steering 占比 / 近 7 天
- `/intervention help` — 用法

## 配置

- `PI_INTERVENTIONS_FILE` — 覆盖数据文件路径（测试用）
- `PI_HOME` — 覆盖仓库根（默认 `~/.pi`）

## 测试

`extensions/pi-web-search/tests/extensions.test.ts` 中 pi-intervention 块：注册面断言 + 快照落盘/corrective 关联功能测试（tmp 目录，无 LLM、确定性）。
