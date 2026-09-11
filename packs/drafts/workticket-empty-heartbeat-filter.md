status: proposed

## 问题
运维自动化体系中，Scheduler keep 空闲保活心跳任务（特征：tools=0、hit=0、输出仅含 `[Scheduler] keep: p` 类心跳文本）被反复提取蒸馏为无信息记忆条目，消耗 token 与存储。2026-09-10 出现多轮空心跳会话，2026-09-11 的归纳 insight 确认该模式已形成系统性浪费——空壳任务被当成有效任务写入 entries.json，污染记忆库并降低健康检查命中率。

## 建议改动
1. 在记忆沉淀流程（task-summarizer / lesson-miner）的前置过滤层增加空壳判定：当任务所有轮次 tools=0 且 hit=0 时，直接跳过 memory_store 与 SKILL 草稿写入，不产出任何记忆条目。
2. 在 daily-health 健康检查中增加空壳条目计数指标，当空壳记忆占比超过阈值时触发告警。
3. 对已存在的空壳记忆条目（标题含「Scheduler keep」「心跳」且内容无实质信息）做批量标记与清理。

## 验证方式
1. 造一组模拟空心跳任务记录（tools=0/hit=0），验证沉淀流程不产出记忆条目。
2. 运行 daily-health，确认空壳计数指标正常上报。
3. 清理后对比 entries.json 条目数与健康检查命中率变化。