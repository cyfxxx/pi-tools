# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

- `agent/settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `agent/extensions/` — 9 个扩展：subagent / pi-context / plan-mode / pi-autopilot / pi-memory / pi-web-search / pi-browser / pi-tmux / pi-voice（能力与配置见各自 README）
- `agent/lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`auto-compact.ts`、`prune.ts`、`usage-diag.ts`、`note-store.ts`、`token-budget.ts`（兼容层）
- `agent/prompts/`、`agent/agents/`、`agent/skills/` — 提示词文档（PI-SDK-EXTENSION.md）、子代理模板、技能
- `scripts/` — rebuild.sh（一键重建+补丁）、pi-wrapper.sh（生命周期）、pi-cron.sh（离线定时）、test-all.sh（回归）、pi-whisper.sh + whisper-server.py（whisper 服务）、pi-bg.sh（后台任务，见 README-pi-bg.md）、patch-*.mjs（见下方补丁生命周期）
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）
- `memory/` — pi-memory 运行时数据（git 忽略）；`logs/` — 运行时日志

## 语音交流（pi-voice，Termux/Android）

- 入口：`/voice <start|stop|cancel|tts|doctor|model|bench|help>`（无参数=切换）；快捷键 Ctrl+Shift+R
- 架构：录音 → ffmpeg 16k → faster-whisper（本地 127.0.0.1:18766，`pi-whisper.sh start` 管理）→ 转写插入/直发；TTS 自动朗读最终回复
- 关键机制：TTS 串行队列合并（防僵尸进程堆积）、录音超时自动转写、听写回车 800ms 防抖、补丁缺失自动禁用回车听写、转写前自动拉起 whisper 服务
- 配置（`~/.pi/agent/pi-voice.json`）/故障排查（麦克风权限、tmux 组合键透传、TTS 无声音）：见 `extensions/pi-voice/README.md`

## 验证命令（全量回归）

```bash
bash scripts/test-all.sh          # 一键：10 套测试（8 vitest + subagent + 注册面）+ tsc + conflict-check
```

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`（pi-web-search 72 / pi-memory 53 / pi-autopilot 89 / pi-browser 23 / pi-context 39 / plan-mode 51 / pi-tmux 10 / pi-voice 52 用例）
注册面：`cd agent/extensions/pi-web-search && ./node_modules/.bin/vitest run tests/extensions.test.ts`（23 用例，须在该目录跑使 mock alias 生效；顶层跑 subagent 用例会因真实包加载超时）
subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs`（37 用例）
类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit`
扩展冲突：`cd agent/extensions && node tests/conflict-check.mjs`（8 项）

## 关键约定

- **扩展注册**：pi 0.83+ 从 `~/.pi/agent/extensions/` 目录自动发现扩展（扫描含 index.ts 的子目录）；settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除，裸路径条目无效），不再承担注册职责；新扩展须同步目录 index.ts、extensions/tsconfig.json include、tests/conflict-check.mjs 监听者清单、extensions.test.ts
- **扩展命令整合规范**（conflict-check.mjs 第 2/2b 项守门）：同一扩展的 slash 命令必须整合为 ≤2 个，具体功能用子命令参数指定（终端程序风格），并支持 `help`/`-h`/`--help` 子命令输出用法；命令 description 应包含子命令清单与 `/xxx help` 提示（这是 `/` 菜单唯一展示面）；子命令补全用 `getArgumentCompletions`。当前命令面：`/voice`、`/auto`、`/schedule`、`/plan`、`/memory`、`/usage-diag`（子命令清单见各扩展 README）。旧命令名（/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart）已移除，新代码禁止引用。新增命令若未同步 conflict-check.mjs 清单会直接报错
- **缓存友好（跨扩展）**：system prompt 注入禁止时间戳与精确数值；压力提示按档位（<75% 不注入、≥75%/≥90% 固定文案）；共享估算统一用 `lib/context-budget.ts` 的 `estimateTokens`；机制细节见 pi-context README
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **旧扩展名残留**：pi-web-toolkit / pi-router / pi-admin / pi-scheduler 均已融合或更名，新代码禁止引用
- **补丁生命周期**：`patch-voice-enter.mjs`（回车拦截，缺失时 pi-voice 自动禁用回车听写）/`patch-footer-live-context.mjs`（footer 实时 token）/`patch-plan-tools.mjs`（--continue 恢复会话的工具 schema）由 rebuild.sh Phase 3 自动执行（幂等）；pi update 升级 dist 后需重跑 rebuild.sh（或手动 node 执行三个脚本）

## 各扩展深度文档（指向）

- **pi-context**（自动压缩/分层擦除/工具截断/thinking 预算/效率注入/usage-diag）：`extensions/pi-context/README.md`
- **plan-mode**（修订语义/缓存特性/bash 白名单/subagent 开放/工具切换）：`extensions/plan-mode/README.md`
- **pi-autopilot**（定时调度/看门狗/failover/预算）：`extensions/pi-autopilot/README.md`
- **pi-tmux**（工具用法/环境缺失/access not allowed 故障）：`extensions/pi-tmux/README.md`
- **pi-memory / pi-web-search / pi-browser / subagent**：各自 README
- **后台任务（pi-bg.sh）**：`scripts/README-pi-bg.md`（四件套隔离：--no-session + --no-extensions + 只读工具集 + 独立日志）
- **tmux 部署**（WSL2/WSLg、GPU、clipboard、resurrect/continuum）：`alacritty-tmux-setup.md`
