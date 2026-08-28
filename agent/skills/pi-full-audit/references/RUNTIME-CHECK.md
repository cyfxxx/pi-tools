# 会话运行检查 + 每日快速巡检（自 SKILL.md 外置，2026-08-28）

> 按需加载：仅触发词「运行检查」「会话检查」「健康巡检」或每日巡检时读取本文件。
> 主流程 SKILL.md 只保留引用行，减少技能加载时的读取次数。

## 会话运行检查（运行时健康巡检）

对**当前 pi 会话的运行态**做健康检查——区别于上述代码审计（审运行态而非代码态）。随时可单独执行（只读、无依赖）。触发词："运行检查""会话检查""健康巡检"。

> **检查缓存命中率时勿启用休眠工具组**：enable_tool 会改变工具列表本身即污染被测的 system prompt 前缀；用只读文件 + usage-stats.mjs 等价完成（2026-08-24 实战）。

### 检查清单（按序）

1. **运行时状态**：`admin_status`（模型/provider/会话文件/思考层级）+ `autopilot_status`（自主运行开关、任务数、遥测、预算、failover）+ `schedule_task list`（定时任务）
2. **缓存命中与 token**：先跑 `node scripts/usage-stats.mjs`（跨会话聚合，幂等；按 startTs 去重入账 `agent/stats/usage-sessions.jsonl`）看历史对比与当前会话断裂/浪费，再读 `agent/.usage-diag.jsonl` 尾部 3 条：
   - 命中率 = cacheRead / (input + cacheRead)，正常 >90%（实测 98%+）；偏低 → system prompt 前缀不稳定（时间戳注入/banding 失效）
   - **统计修正（2026-08-14 实战）**：先排除 run 边界轮——重启/--continue 恢复/新实例后的首轮必然重发（context 重建），不算异常；usage-diag 记录所有 turn_end（含同机其他 pi 实例、昨晚实例），统计全量时先按时间窗口滤出当前会话活跃期
   - **断裂点定位法**：低命中轮的 cacheRead ≈ 断裂点位置。断裂点 ≈ system prompt 尾部 → **systemPrompt 拼入式注入**（如 pi-memory 旧实现）——变化时全部历史重发，应改为消息注入；断裂点在消息末尾 → 注入块变化，成本仅注入本身（≤几 K），正常
   - **请求级验证法（比 usage 统计更精确）**：usage 的 in≈40-50K 并不等于消息序列断裂——写临时 debug 扩展监听 `before_provider_request`，对每条消息做完整内容 hash，对比相邻请求：前 N 条 hash 全同 = 无断裂（in 大是 DeepSeek 侧缓存未命中，与消息内容无关）；首个不同消息 = 精确断裂点。测完删除扩展
   - **缓存断裂成因（2026-08-18 更新分类，thinking 剪枝根因已定位）**：A 注入变化（systemPrompt 拼入式注入，已修）；B **post-hoc 消息修改**（thinking 剪枝/分层擦除等事后改历史——2026-08-18 实测根因：16K thinking 预算每 2-3 轮超限删早期 thinking → 3.8h 27 次断裂、1.46M token 浪费；已调阈值 64K/120K/80K 休眠）；C DeepSeek 侧缓存未命中（100K+ 上下文偶发 in≈41K 轮，消息序列无断裂）；D run 边界（重启/恢复首轮）。**诊断提示**：断裂轮出现且 cacheRead 残值单调后移 → 查 lib/prune.ts 阈值是否被回退（`node agent/extensions/tests/cache-guard.mjs` 有契约校验）
   - **注入面守门**（2026-08-18 新增）：`node agent/extensions/tests/cache-guard.mjs` 校验注入面指纹（AGENTS.md/注入文案/阈值）——任何漂移必须显式 `--update-baseline`，否则回退式改动直接阻断
   - **工具列表跨会话漂移**（2026-08-18 新增）：`agent/stats/tool-fingerprint.jsonl`（conflict-check 每次运行入账）——工具 schema 是 system prompt 一部分，漂移破坏前缀；查看最后两条 timestamp 间隔与内容
   - input 应远小于 cacheRead（每轮只发增量）；input 涨到数千 → 历史膨胀
   - contextTokens 接近预算上限 → 报告压力档位注入（≥75%/≥90% 文案）
   - 自动压缩触发次数高（usage-diag 中 `type:"auto-compact"` 事件行）→ 检查 pi-context 压缩配置
3. **会话体积**：会话 jsonl 大小 + 消息数（对比历史会话，异常膨胀提示上下文失控）
4. **注入块**（适用性检查）：注入内容无时间戳/精确数值（缓存友好）。注意实测（2026-08-14）：注入在请求时生成、**不落盘会话文件**时，`grep -c pi-memory-injection <会话文件>` 只能命中工具参数文本，计数无意义——改用检查项 2 的缓存命中率反证注入稳定性；仅当会话文件中可见注入 customType 标记（落盘环境）时才用 grep 计数（应≈请求轮数）
   - **内容质量抽查**（2026-08-15 实战发现三类残留，已修复）：① 重复摘要（同 sessionId 多条历史摘要均注入——根因 appendSummary 无 upsert，已修）；② 空摘要（"开场问候无实质内容""无可提取"类仍在注入——已修 doExtract 质量门 + isSubstantiveSummary 过滤）；③ 硬截断条目（slice(0,200) 切半如"跨""用 readlink "——已修 truncateByTokens 80 token 带标记）。抽查 memory/summaries.json 与注入块构建逻辑，验证修复持续生效（无新增重复/空摘要/残句）

5. **日志与残留**：`ls -lt logs/` 查错误；`logs/tmux/` 残留日志（测试遗留可清）；`tmux_status` 活动会话
6. **后台任务**：`crontab -l` 中 pi-cron.sh；watchdog 状态文件（`agent/.pi-autopilot-state.json` 存在 = 触发过）
7. **真实运行观察（keyless snapshot 替代，2026-08-14 沉淀）**：mock 测试发现不了缓存/注入/状态流问题（本次 72K 重发就是 mock 全绿+真实运行才暴露的）。做法：实际触发一轮关键路径操作并观察行为：
   - `memory_store` 写一条 → 观察该轮 usage：记忆变化轮 input 应 <500（消息注入已修复）；>70K = 拼入式注入回退
   - `todo update`（plan-mode）→ 观察状态条/overlay 即时刷新 + 该轮 input
   - bash 大输出轮 in≈50K 属 DeepSeek 侧缓存现象（消息序列无断裂，请求级 hash 验证法确认），不算注入回归
   - 验证模板（2026-08-14 实测）：记忆变化轮 in=40-92 token 命中 100%；连续相邻请求逐消息 hash 全同
   - 基准工具：`bash scripts/pi-bench.sh usage`（聚合报告）`timing`（关键计时）`compare <基准>`（退化检测）

### 判定基准（2026-08-14 实测沉淀）

| 指标 | 正常 | 异常 |
|---|---|---|
| 缓存命中率 | >90%（实测 98%+） | 偏低 → 注入稳定性问题（排除 run 边界轮后仍低 = 实锤；断裂点 ≈ system prompt 尾部 → systemPrompt 拼入式注入需改消息注入） |
| 每轮 input | <2K | 涨 → 历史膨胀/缓存失效 |
| 自动压缩触发 | 偶发 | 频繁 → 压缩配置 |
| 定时任务/遥测 | 与配置一致 | 任务缺失、遥测失败率高 |
| failover | 未配置属正常 | 配置了但频繁切换 → 模型不稳定 |

### 输出格式

```
## 会话运行检查报告
**会话**: <文件> | **模型**: <provider/model>
1. 提示词注入: ✓/✗ + 依据
2. 工具调用: ✓/✗（无扩展报错/未处理异常）
3. 缓存命中: xx%（基准 >90%）
4. token 消耗: context xxK / 预算 xxK / 自动压缩次数（usage-diag auto-compact 事件行）
5. 自动执行: ✓/✗（任务/遥测/预算/watchdog）
结论: 正常 / N 项异常（附修复建议）
```

### 与代码审计的关系

运行检查发现问题需要改代码时：小改动走 pi-code-review（审查 diff 后修），系统性改动转本技能第 6 步（修复闭环）。运行检查不替代审计，两者互补。

## 每日快速巡检模式（轻量只读，2026-08-27 吸收 drafts/daily-ops-review）

每日整体复检 pi 前一日运行情况，**只读为主、不深入探索**（防 token 浪费，参考一轮 tools 6-12 个、out ~500 tokens）。后台独立会话执行（tmux_run），勿改配置，工作目录 `cd /root/.pi`。

1. **缓存命中**：`node scripts/usage-stats.mjs` 看当前/近期会话命中率与断裂
2. **健康日志**：`ls -lt logs/` 找异常（ERROR/扩展报错），查 tmux 残留
3. **订阅产出**：知识订阅当日输出非空（knowledge-fetch 任务 lastRun 成功、.seen.txt 未全命中）
4. **存储水位**：`node scripts/usage-stats.mjs --json` 看会话体积；`du -sh memory/ logs/` 水位（参考阈值：缓存命中 >96%、断裂 ≤1 次 A 类、浪费 <50K tokens、存储 <2MB/条目 <600 为正常）
5. **汇总**：一条 bash 聚合完成全部检查项；输出仅"ok / 异常项清单"两类结论；异常项创建后续任务处理，不在当轮深挖

