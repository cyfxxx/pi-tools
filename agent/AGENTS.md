# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。
细节与完整目录清单见 `docs/AGENTS-DETAILS.md`（需要时 read）。

## 目录结构（概览）

- `agent/` — 配置（settings.json）+ 扩展（extensions/，10 个）+ 共享库（lib/）+ 代理模板/技能/提示模板（agents/ skills/ prompts/）
- `packs/` — 统一外部技能仓库：`packs/<name>/` 已确认技能包（comfyui-agent/colab-bridge/gamedev/reverse-skill）+ `packs/drafts/` 草稿（草稿确认后直接建包，无 active 中间态；同类型技能合并进现有包）。详见 `packs/README.md`
- `portable/` — 便携 pi（Windows 原生）种子，完整经验见 `portable/README.md`
- `scripts/` — 生命周期与工具脚本（rebuild/test-all/pi-bg/pi-whisper 等）
- `deploy/` — 部署配置（systemd/tmux/keys）；`searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略）
- `docs/` — 开发与部署文档（ENVIRONMENTS.md 等）
- `memory/` — pi-memory 运行时数据（git 忽略）；`logs/` — 运行时日志

## 多环境使用约定

- 本仓库在 Termux/Android、WSL2、Linux 等环境间同步使用（GitHub）。**配置层（settings.json/models.json/auth.json）每环境独立**，不跨机覆盖
- **例外：`.pi-autopilot-config.json` 入库共享**（无密钥）。某环境需独立值时本地直接改（不入库），或明确是共享变更时改后推送
- **记忆带环境标签**（`environments` 字段）：`all` 通用 / `termux` / `wsl2` / `linux` / `macos` / `windows`，注入与检索自动按当前环境过滤；知识本身与环境相关才打标
- **运行时数据隔离**：notes.json / summaries.json / checkpoints / sessions / logs 不入库；entries.json（长期记忆）入库共享，冲突以最新 push 为准（`git checkout --theirs`）
- 环境识别/差异表/切换流程：见 `docs/ENVIRONMENTS.md`

## 验证命令

```bash
bash scripts/test-all.sh          # 一键全量回归（含 cache-guard 注入面守门）
bash scripts/test-all.sh --only=<ext1>,<ext2>  # 分层快检
bash scripts/test-all.sh --fast   # 跳过 subagent/注册面/conflict-check/cache-guard
node scripts/usage-stats.mjs      # 跨会话缓存命中统计（幂等，输出历史对比与当前差距）
```

单套件/注册面/subagent/tsc 细节：见 `docs/AGENTS-DETAILS.md`。

## 关键约定

- **扩展注册**：pi 0.83+ 自动发现 `extensions/` 下含 index.ts 的子目录；settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除）。新扩展须同步：目录 index.ts、extensions/tsconfig.json include、conflict-check.mjs 监听者清单、extensions.test.ts
- **扩展命令整合规范**：同一扩展 slash 命令 ≤2 个，子命令参数实现，支持 help/-h/--help；子命令补全用 getArgumentCompletions。当前命令面：/voice、/auto、/schedule、/plan、/memory、/usage-diag、/link、/tools。旧命令名与旧扩展名（pi-web-toolkit / pi-router / pi-admin / pi-scheduler）禁止引用
- **缓存友好（跨扩展）**：system prompt 注入禁止时间戳/精确数值；压力提示按档位（<75% 不注入、≥75%/≥90% 固定文案）；估算统一用 lib/context-budget.ts 的 estimateTokens；停止生成用 ctx.abort()；细节见 pi-context README / docs/PI-EXT-DEV-NOTES.md
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **后台任务（禁止阻塞前台）**：tmux_run 启动后**立即结束回合**（notify 默认自动唤醒：命令自然结束会话自动退出触发通知；Ctrl-C 中断/长驻命令会话保留，供 tmux_send 交互）；同轮内禁止 tmux_wait；确需等待只用 pattern= 匹配完成标志且 timeout≤60s；until_exit 仅限会自然退出的命令（2026-08-22 起 tmux_run 默认自动退出，until_exit 可直接用）；仅用户明确要求"等它完成"时例外；无 tmux 环境用 nohup 记 PID
- 旧扩展名（pi-web-toolkit / pi-router / pi-admin / pi-scheduler）已融合更名，禁止引用
- **补丁生命周期**：8 个 patch-*.mjs 由 rebuild.sh Phase 3 自动执行（幂等）；pi update 后需重跑 rebuild.sh（wrapper 内执行 pi update 时 L3 钩子自动 rebuild）。清单见 docs/AGENTS-DETAILS.md
- **已知噪音（勿误判）**：pi-voice 回车键冲突警告属设计行为，无需处理。见 docs/AGENTS-DETAILS.md

## 各扩展深度文档（指向）

- **pi-context**（自动压缩/分层擦除/工具截断/thinking 预算/效率注入/usage-diag）：`extensions/pi-context/README.md`
- **plan-mode**（修订语义/缓存特性/bash 白名单/subagent 开放/工具切换）：`extensions/plan-mode/README.md`
- **pi-autopilot**（定时调度/看门狗/failover/预算）：`extensions/pi-autopilot/README.md`
- **pi-tmux**（工具用法/环境缺失/access not allowed 故障）：`extensions/pi-tmux/README.md`
- **pi-link**（多设备互联：ssh 通道 + 远程 pi RPC，设备清单 `pi-link.json`、安全边界、加固 forced command）：`extensions/pi-link/README.md`
- **pi-memory / pi-web-search / pi-browser / subagent**：各自 README
- **pi-voice**（Termux 语音：入口 Ctrl+Alt+R 与 `/voice`，录音/转写/TTS/听写，配置 `pi-voice.json`、故障排查）：`extensions/pi-voice/README.md`
- **后台任务（pi-bg.sh）**：`scripts/README-pi-bg.md`（四件套隔离：--no-session + --no-extensions + 只读工具集 + 独立日志）
- **tmux 部署**（WSL2/WSLg、GPU、clipboard、resurrect/continuum）：`docs/alacritty-tmux-setup.md`