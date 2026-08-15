# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

- `agent/settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `agent/extensions/` — 9 个扩展：subagent / pi-context / plan-mode / pi-autopilot / pi-memory / pi-web-search / pi-browser / pi-tmux / pi-voice（能力与配置见各自 README）
- `agent/lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`auto-compact.ts`、`prune.ts`、`usage-diag.ts`、`note-store.ts`、`token-budget.ts`（兼容层）、`registry.ts`（注册/清理统一封装，dsh 借鉴）、`config.ts`（配置分层合并，默认+overlay 深合并）
- `agent/agents/`、`agent/skills/` — 子代理模板、技能；`agent/prompts/` — pi 全局 prompt templates 加载目录（`*.md` 自动注册为 `/name` 斜杠命令）；Pi SDK 文档见 `docs/PI-SDK-EXTENSION.md`
- `scripts/` — rebuild.sh（一键重建+补丁）、pi-wrapper.sh（生命周期）、pi-cron.sh（离线定时）、test-all.sh（回归，支持 --only/--fast 分层）、pi-bench.sh（用量基准：usage/timing/compare）、pi-whisper.sh + whisper-server.py（whisper 服务）、pi-bg.sh（后台任务，见 README-pi-bg.md）、patch-*.mjs（见下方补丁生命周期）
- `deploy/` — 部署配置：`deploy/systemd/`（unit 模板）、`deploy/tmux/`（tmux.conf 与状态脚本）、`deploy/keys/`（pi-link 公钥合集）
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）
- `docs/` — 开发与部署文档（Termux 注意事项/Pi 扩展注意事项/SDK/tmux 部署/多环境指南 ENVIRONMENTS.md）

## 多环境使用约定

- 本仓库在 Termux/Android、WSL2、Linux 等环境间同步使用（GitHub）。**配置层（settings.json/models.json/auth.json）每环境独立**，不跨机覆盖（首次 clone 后按本机配置）
- **例外：`.pi-autopilot-config.json` 入库共享**（看门狗阈值/策略默认值，无密钥）。多环境 pull 后共享同一配置；某环境需要独立值时：本地直接改文件即可（不入库不推送），或改后推送覆盖其他环境（明确是共享变更时）——改前先确认意图
- **记忆带环境标签**（pi-memory `environments` 字段）：`all` 通用 / `termux` / `wsl2` / `linux` / `macos` / `windows`；注入与检索自动按当前环境过滤。判定原则：知识本身与环境相关才打标；只是"在该环境发现"的通用知识标 all
- **运行时数据隔离**：notes.json / summaries.json / checkpoints / sessions / logs 不入库（多机 pull/push 会互相覆盖）；entries.json（长期记忆）入库共享，冲突时以最新 push 为准（`git checkout --theirs`）
- 环境识别/差异表/切换流程：见 `docs/ENVIRONMENTS.md`
- `memory/` — pi-memory 运行时数据（git 忽略）；`logs/` — 运行时日志

## 验证命令（全量回归）

```bash
bash scripts/test-all.sh          # 一键：11 套测试（9 vitest + subagent + 注册面）+ tsc + conflict-check
bash scripts/test-all.sh --only=pi-voice,pi-tmux  # 分层快检：只跑指定扩展 + tsc（dsh 证据面匹配借鉴）
bash scripts/test-all.sh --fast   # 跳过 subagent/注册面/conflict-check（日常快检）
```

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`（pi-web-search 75 / pi-memory 85 / pi-autopilot 97 / pi-browser 24 / pi-context 61 / plan-mode 69 / pi-tmux 13 / pi-voice 128 / pi-link 57 用例，2026-08-15 实测，以 test-all.sh 输出为准）
注册面：`cd agent/extensions/pi-web-search && ./node_modules/.bin/vitest run tests/extensions.test.ts`（25 用例，须在该目录跑使 mock alias 生效；顶层跑 subagent 用例会因真实包加载超时）
subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs`（59 用例）
类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.local.json --noEmit`（必须 local.json——共享 tsconfig.json 的 paths 为空会全量报 Cannot find module；缺失时回退共享配置）
扩展冲突：`cd agent/extensions && node tests/conflict-check.mjs`（8 项）

## 关键约定

- **扩展注册**：pi 0.83+ 从 `~/.pi/agent/extensions/` 目录自动发现扩展（扫描含 index.ts 的子目录）；settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除，裸路径条目无效），不再承担注册职责；新扩展须同步目录 index.ts、extensions/tsconfig.json include、tests/conflict-check.mjs 监听者清单、extensions.test.ts
- **扩展命令整合规范**（conflict-check.mjs 第 2/2b 项守门）：同一扩展的 slash 命令必须整合为 ≤2 个，具体功能用子命令参数指定（终端程序风格），并支持 `help`/`-h`/`--help` 子命令输出用法；命令 description 用简短功能描述并附 `/xxx help` 提示（完整子命令清单由 help 输出与 `getArgumentCompletions` 补全承担，不再写入 description）；子命令补全用 `getArgumentCompletions`。当前命令面：`/voice`、`/auto`、`/schedule`、`/plan`、`/memory`、`/usage-diag`、`/link`（send/watch/attach/inbox/export-card/import-card/status/help）（子命令清单见各扩展 README）。旧命令名（/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart）已移除，新代码禁止引用。新增命令若未同步 conflict-check.mjs 清单会直接报错
- **缓存友好（跨扩展）**：system prompt 注入禁止时间戳与精确数值；压力提示按档位（<75% 不注入、≥75%/≥90% 固定文案）；共享估算统一用 `lib/context-budget.ts` 的 `estimateTokens`；排序类注入高分前缀 banding 锚定（数据增量不破坏缓存前缀）；停止生成用 `ctx.abort()` 而非提示词；机制细节见 pi-context README / docs/PI-EXT-DEV-NOTES.md
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **后台任务（禁止阻塞前台）**：tmux_run 启动长任务后**立即结束回合**，进度在后续轮次用 tmux_read 轮询（响应其他消息时顺带查看）；**tmux_run 后同一轮内禁止 tmux_wait**——等待期间无法处理用户消息，等同占用前台（三次实战教训：2026-08-14 rebuild 任务 tmux_wait 连续阻塞 6 分钟×2；2026-08-15 全量回归 until_exit 阻塞 420 秒——命令尾部 bash 仍存活会话不退出，until_exit 注定等满超时）。确需等待时只用 `pattern=` 匹配具体完成标志且 timeout≤60s；until_exit 仅限命令会自然退出（尾部 `; exec true`）的形态。仅用户明确要求"等它完成"时例外；无 tmux 环境用 nohup 记 PID
- **旧扩展名残留**：pi-web-toolkit / pi-router / pi-admin / pi-scheduler 均已融合或更名，新代码禁止引用
- **补丁生命周期**：`patch-voice-enter.mjs`（回车拦截，缺失时 pi-voice 自动禁用回车听写）/`patch-footer-live-context.mjs`（footer 实时 token）/`patch-plan-tools.mjs`（--continue 恢复会话的工具 schema）由 rebuild.sh Phase 3 自动执行（幂等）；pi update 升级 dist 后需重跑 rebuild.sh（或手动 node 执行三个脚本）
- **已知噪音（勿误判为 bug）**：pi 启动时可能打印 `Extension shortcut conflict: 'return'/'shift+enter' is built-in shortcut for tui.input.newLine and .../pi-voice/index.ts. Using .../pi-voice/index.ts.`——这是 pi-voice 故意注册回车键（`Key.return` + `Key.shift('enter')`，enter 本身是保留键会被静默丢弃）用于录音中切段转写，与内置 `tui.input.newLine` 冲突属设计行为（restrictOverride=false，扩展生效）。功能安全由 patch-voice-enter.mjs 保证（未录音时 handler 返回 false 放行回车）。扩展 API 无注销接口，无法消除该警告，无需处理

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
