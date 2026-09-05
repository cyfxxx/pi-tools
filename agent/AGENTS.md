# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。
细节与完整目录清单见 `docs/AGENTS-DETAILS.md`（需要时 read）。

## 目录结构（概览）

- `agent/` — 配置（settings.json）+ 扩展（extensions/）+ 共享库（lib/）+ 代理模板/技能/提示模板（agents/ skills/ prompts/）
- `packs/` — 统一外部技能仓库：`packs/<name>/` 技能包 + `packs/drafts/` 技能草稿。详见 `packs/README.md`
- `portable/` — 便携 pi（Windows 原生）种子，完整经验见 `portable/README.md`
- `scripts/` — 生命周期与工具脚本（rebuild/test-all/pi-bg 等）
- `deploy/` — 部署配置（systemd/tmux/keys）
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略）
- `docs/` — 开发与部署文档（ENVIRONMENTS.md 等）
- `memory/` — pi-memory 运行时数据（entries.json 入库共享，其余 git 忽略）；`logs/` — 运行时日志
- `plans/` — plan-mode 计划存档（git 忽略，每计划含独立 .git，供计划内 git 操作）

- **项目愿景与进化纪律**：顶层权威文档 `docs/VISION.md`（终极目标/方法论/度量体系/治理规则...）；执行跟踪 `docs/SELF-OPTIMIZING-ROADMAP.md`。涉及行为准则、记忆淘汰/升格、新扩展命令面的决策先对齐 VISION

## 多环境使用约定

- 本仓库在 Termux/Android、WSL2、Linux 等环境间同步使用（GitHub）。**配置层（settings.json/models.json/auth.json）每环境独立**，不跨机覆盖
- **例外：`.pi-autopilot-config.json` 入库共享**（无密钥）。某环境需独立值时本地直接改（不入库），或明确是共享变更时改后推送
- **记忆带环境标签**（`environments` 字段）：`all` 通用 / `termux` / `wsl2` / `linux` / `macos` / `windows`，注入与检索自动按当前环境过滤；知识本身与环境相关才打标
- **运行时数据隔离**：notes.json / summaries.json / checkpoints / sessions / logs 不入库；entries.json（长期记忆）入库共享，发生冲突时先检查在合并
- 环境识别/差异表/切换流程：见 `docs/ENVIRONMENTS.md`

## 验证命令

```bash
bash scripts/test-all.sh          # 一键全量回归（含 cache-guard 注入面守门）
bash scripts/test-all.sh --only=<ext1>,<ext2>  # 分层快检
bash scripts/test-all.sh --fast   # 跳过 subagent/注册面/conflict-check/cache-guard/doc-lint/发现完整性（--only 同样跳过 doc-lint 与发现完整性）
node scripts/usage-stats.mjs      # 跨会话缓存命中统计（幂等，输出历史对比与当前差距）
```

单套件/注册面/subagent/tsc 细节：见 `docs/AGENTS-DETAILS.md`。

## 关键约定

- **扩展注册**：pi 0.83+ 自动发现 `extensions/` 下含 index.ts 的子目录；settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除）。新扩展须同步：目录 index.ts、extensions/tsconfig.json include、conflict-check.mjs 监听者清单、extensions.test.ts（位于 pi-web-search/tests/ 下）
- **APPEND_SYSTEM.md 注入面**：agent/APPEND_SYSTEM.md 由 pi 核心原生加载追加到 system prompt（非扩展机制），改动会影响缓存前缀
- **扩展命令整合规范**：同一扩展 slash 命令 ≤2 个，子命令参数实现，支持 help/-h/--help；子命令补全用 getArgumentCompletions。
- **缓存友好（跨扩展）**：system prompt 注入禁止时间戳/精确数值；压力提示按档位（<75% 不注入、≥75%/≥90% 固定文案）；估算统一用 lib/context-budget.ts 的 estimateTokens；停止生成用 ctx.abort()；细节见 pi-context README / docs/PI-EXT-DEV-NOTES.md
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **后台任务（禁止阻塞前台）**：tmux_run 启动后**立即结束回合**（notify 默认自动唤醒：命令自然结束会话自动退出触发通知；Ctrl-C 中断/长驻命令会话保留，供 tmux_send 交互）；同轮内禁止 tmux_wait；确需等待只用 pattern= 匹配完成标志且 timeout≤60s；tmux_run 默认自动退出，until_exit 可直接用；仅用户明确要求"等它完成"时例外；无 tmux 环境用 nohup 记 PID
- 旧扩展名（pi-web-toolkit / pi-router / pi-admin / pi-scheduler）已融合更名，禁止引用
- **补丁生命周期**：9 个 patch 文件由 rebuild.sh 自动执行（幂等）：8 个无条件 + patch-playwright-core.mjs 仅 Termux 条件；pi update 后需重跑 rebuild.sh（wrapper 内执行 pi update 时 L3 钩子自动 rebuild）。清单见 docs/AGENTS-DETAILS.md
- **已知噪音（勿误判）**：pi-voice 回车键冲突警告属设计行为，无需处理。见 docs/AGENTS-DETAILS.md

## 各扩展深度文档（指向）

- **文档地址**：`extensions/<name>/README.md`
- **pi-context**（上下文管理）、**plan-mode**（计划模式）、**pi-autopilot**（定时调度）、**pi-tmux**（后台任务）、 **pi-link**（多设备互联）、**pi-intervention**（干预捕获）、**pi-memory**（记忆管理）、**pi-web-search**（网络搜索）、**pi-browser**（浏览器操作）、**subagent**（子代理）、**pi-voice**（语音输入）
- **后台任务（pi-bg.sh）**：`scripts/README-pi-bg.md`（四件套隔离：--no-session + --no-extensions + 软只读工具集（含 bash，写保护仅提示词级非沙箱）+ 独立日志）
