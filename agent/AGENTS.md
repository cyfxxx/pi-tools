# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

- `agent/settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `agent/extensions/` — 6 个已注册扩展：subagent / pi-context / pi-autopilot / pi-memory / pi-web-search / pi-browser（+ 未启用的 plan-mode）
- `agent/lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`note-store.ts`、`token-budget.ts`/`prune.ts`（兼容层）
- `agent/prompts/` — 提示词文档（PI-SDK-EXTENSION.md）
- `agent/agents/`、`agent/skills/` — 子代理模板与技能
- `scripts/` — rebuild.sh 一键重建、pi-wrapper.sh 生命周期、pi-cron.sh 定时、test-all.sh 回归
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）
- `memory/` — pi-memory 运行时数据（git 忽略）

## 验证命令（全量回归）

```bash
bash scripts/test-all.sh          # 一键：5 套测试 + tsc + conflict-check
```

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`（pi-web-search 72 / pi-memory 49 / pi-autopilot 86 / pi-browser 23 用例）
subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --experimental-loader ./tests/loader.mjs ./tests/test.mjs`（34 用例）
类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit`
扩展冲突：`cd agent/extensions && node tests/conflict-check.mjs`（6 项）

## 关键约定

- **扩展注册**：新扩展须同步 settings.json extensions、extensions/tsconfig.json include、tests/conflict-check.mjs 监听者清单、extensions.test.ts
- **缓存友好**：system prompt 注入禁止时间戳与精确数值；压力提示按档位（<85% 不注入、≥85%/≥95% 固定文案）；共享估算统一用 `lib/context-budget.ts` 的 `estimateTokens`
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **旧扩展名残留**：pi-web-toolkit / pi-router / pi-admin / pi-scheduler 均已融合或更名，新代码禁止引用
