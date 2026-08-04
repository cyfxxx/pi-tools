# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

- `agent/settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `agent/extensions/` — 7 个已注册扩展：subagent / pi-context / plan-mode / pi-autopilot / pi-memory / pi-web-search / pi-browser
- `agent/lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`auto-compact.ts`（按窗口比例自动压缩阈值+防抖+压缩后自动继续门）、`prune.ts`（兼容层 + 工具输出分层擦除）、`usage-diag.ts`（每轮 LLM 用量诊断记录/汇总）、`note-store.ts`、`token-budget.ts`（兼容层）
- `agent/prompts/` — 提示词文档（PI-SDK-EXTENSION.md）
- `agent/agents/`、`agent/skills/` — 子代理模板与技能
- `scripts/` — rebuild.sh 一键重建、pi-wrapper.sh 生命周期、pi-cron.sh 定时、test-all.sh 回归
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）
- `memory/` — pi-memory 运行时数据（git 忽略）

## 验证命令（全量回归）

```bash
bash scripts/test-all.sh          # 一键：7 套测试 + tsc + conflict-check
```

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`（pi-web-search 72 / pi-memory 53 / pi-autopilot 86 / pi-browser 23 / pi-context 31 / plan-mode 15 用例）
subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs`（34 用例）
类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit`
扩展冲突：`cd agent/extensions && node tests/conflict-check.mjs`（6 项）

## 关键约定

- **扩展注册**：新扩展须同步 settings.json extensions、extensions/tsconfig.json include、tests/conflict-check.mjs 监听者清单、extensions.test.ts
- **缓存友好**：system prompt 注入禁止时间戳与精确数值；压力提示按档位（<85% 不注入、≥85%/≥95% 固定文案）；共享估算统一用 `lib/context-budget.ts` 的 `estimateTokens`
- **自动压缩**：pi 内置压缩阈值 = 窗口 − reserveTokens，对 1M 窗口模型高达 96.7 万形同虚设；由 pi-context 在 agent_end 按窗口比例触发（>256K 窗口 20% / ≤256K 85%），阈值计算与防抖见 `lib/auto-compact.ts`；ctx.compact() 会 abort 当前 agent 且不 await 完成（扩展 API 为 void + onComplete 回调），故判定放 agent_end、压缩完成由 session_compact 事件通知；`AutoContinueGate` 在压缩完成后自动注入继续指令（triggerTurn:true 启动新一轮），180s cooldown 防递归
- **分层擦除**：pi-context 在 context 事件阶段做工具输出事后擦除（借鉴 opencode prune）：最近 2 轮 + 40K token 保护带内保留，更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构），预计回收 ≥20K 才应用；判定确定性、擦除点单调后移，缓存前缀稳定；见 `lib/prune.ts`
- **用量诊断**：`/usage-diag` 显示每轮 input/缓存/输出汇总（记录在 `~/.pi/agent/.usage-diag.jsonl`，仅展示不进 LLM 上下文）；扩展的异步回调不得使用捕获的 ctx（session 替换后 stale ctx 抛错），需先取值
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **旧扩展名残留**：pi-web-toolkit / pi-router / pi-admin / pi-scheduler 均已融合或更名，新代码禁止引用
