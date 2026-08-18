# AGENTS.md 细节索引（按需加载）

本文件承接 AGENTS.md 移出的细节，需要时 read 本文件（通常一次 <1K token 即命中所需段落）。

## 目录结构详情

### agent/
- `settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `extensions/` — 10 个扩展：subagent / pi-context / plan-mode / pi-autopilot / pi-memory / pi-web-search / pi-browser / pi-tmux / pi-voice / pi-link
- `lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`auto-compact.ts`、`prune.ts`、`usage-diag.ts`、`note-store.ts`、`token-budget.ts`（兼容层）、`registry.ts`（注册/清理统一封装）、`config.ts`（配置分层合并）
- `agents/`、`skills/` — 子代理模板、技能；`prompts/` — pi 全局 prompt templates 加载目录（`*.md` 自动注册为 `/name` 斜杠命令）；Pi SDK 文档见 `docs/PI-SDK-EXTENSION.md`

### portable/（便携 pi，Windows 原生种子）
- `bin/` — setup/verify/diag/update-pi/update-portable/sync/check-restart/check-services/searxng-setup/whisper-setup 等管理脚本
- start.bat/start.ps1 入口、ca-bundle.crt、tools/tmux shim
- 不含 .pi 内容，含密钥的配置不入库
- 完整经验见 `portable/README.md` 与记忆条目「便携 pi Windows 最终架构」

### scripts/
- rebuild.sh（一键重建+补丁）/ pi-wrapper.sh（生命周期）/ pi-cron.sh（离线定时）
- test-all.sh（回归，--only/--fast 分层）/ pi-bench.sh（用量基准）/ docker-rebuild-test.sh（Docker 干净环境重建回归）
- pi-whisper.sh + whisper-server.py（whisper 服务）/ pi-bg.sh（后台任务，见 README-pi-bg.md）/ smoke-test.sh（冒烟）
- termux-prereq.sh（Termux 前置）/ install-wrapper.sh + pi-orig.sh（wrapper 安装/逃生）
- install-cron.sh / install-systemd.sh（调度安装）/ patch-*.mjs（见下方补丁生命周期）

### deploy/ 与 searxng/
- `deploy/systemd/`（unit 模板）、`deploy/tmux/`（tmux.conf 与状态脚本）、`deploy/keys/`（pi-link 公钥合集）
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）

## 回归验证细节

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`
（基线用例数：pi-web-search 75 / pi-memory 94 / pi-autopilot 106 / pi-browser 25 / pi-context 89 / plan-mode 69 / pi-tmux 19 / pi-voice 128 / pi-link 57，以 test-all.sh 当前输出为准）

注册面：`cd agent/extensions/pi-web-search && ./node_modules/.bin/vitest run tests/extensions.test.ts`
（须在该目录跑使 mock alias 生效；顶层跑 subagent 用例会因真实包加载超时）

subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs`

类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.local.json --noEmit`
（必须 local.json——共享 tsconfig.json 的 paths 为空会全量报 Cannot find module；缺失时回退共享配置）

## 补丁生命周期

`patch-voice-enter.mjs`（回车拦截，缺失时 pi-voice 自动禁用回车听写）
`patch-footer-live-context.mjs`（footer 实时 token）
`patch-footer-cache.mjs`（footer CH 双命中率实时/会话 + context 去百分比；依赖前者的实时 context 形态）
`patch-footer-format.mjs`（footer 前 3 字段符号 Σ/↑/↓ + 成本人民币；依赖 cache 补丁之后的形态）
`patch-footer-restart-hint.mjs`（上下文 >40% 窗口时 context 区追加 ⚠，提示重启前先压缩；依赖 cache 补丁的实时 context 形态）
`patch-plan-tools.mjs`（--continue 恢复会话的工具 schema）
`patch-tab-arg-completion.mjs`（tab 参数补全）
`patch-playwright-core.mjs`（Termux android→linux 平台补丁）

共 8 个由 rebuild.sh Phase 3 自动执行（幂等）；pi update 升级 dist 后需重跑 rebuild.sh（或手动 node 执行八个脚本）。

footer 状态栏口径速查：`Σ/↑/↓`=会话累计（Σ=总输入=命中+未命中 / ↑=累计未命中输入 / ↓=累计输出）；`CH{x}/{y}%`=左实时（最近一轮）/右会话累计；context 区 `34.5k/200k`=实时/窗口（>40% 追加 ⚠ 提示重启前先压缩、>70% 黄、>90% 红，无括号百分比）；`¥`=成本人民币（参考汇率 6.77=2026-08 近 90 天中位数，常量在 patch-footer-format.mjs，改汇率后重跑自动更新 dist）。

重启/压缩策略（2026-08-17 对齐 DeepSeek Harness dsh 源码结论）：
- **日常压缩阈值** thresholdRatio 0.8（dsh compaction-basic 同值，晚压缩更优；verbatim tail 由 pi 内核 keepRecentTokens=20000 实现，同 dsh retainRatio 0.16 思路）
- **重启/恢复阈值** 40% 窗口（PI_CONTEXT_RESTART_RATIO 可覆盖）：session_start 时上下文 ≥40% 窗口即自动压缩（pi-context index.ts），首轮不会再全量重发；admin_restart 工具超阈值前会 warning 提示先 /compact
- **dsh 调研要点**（npm 包 @deepseek-ai/dsh 0.1.0-rc.7 源码）：无显式缓存优化代码，缓存友好是架构默认——静态 persona（{{model}}/{{cwd}} 启动时解析一次，无时间戳）、compaction 阈值 0.8+retainRatio 0.16、token-meter 按 input+cacheRead+cacheWrite 算压力。我们已全部对齐/超额。
- **自动重启间隔**：看门狗 maxIdleMinutes 由用户改为 180（3 小时，.pi-autopilot-config.json；types.ts 默认同步），挂死判定放宽避免误杀长思考。

补丁恢复保障：pi update 经 pi-wrapper.sh L3 拦截（CLI 一次性命令），成功后自动重跑 rebuild.sh 恢复全部补丁；手动 `bash scripts/rebuild.sh` 同样幂等可恢复。

## 已知噪音（勿误判为 bug）

pi 启动时可能打印 `Extension shortcut conflict: 'return'/'shift+enter' is built-in shortcut for tui.input.newLine and .../pi-voice/index.ts. Using .../pi-voice/index.ts.`

这是 pi-voice 故意注册回车键（`Key.return` + `Key.shift('enter')`，enter 本身是保留键会被静默丢弃）用于录音中切段转写，与内置 `tui.input.newLine` 冲突属设计行为（restrictOverride=false，扩展生效）。功能安全由 patch-voice-enter.mjs 保证（未录音时 handler 返回 false 放行回车）。扩展 API 无注销接口，无法消除该警告，无需处理。

## 后台任务阻塞教训（历史）

- 2026-08-14：rebuild 任务 tmux_wait 连续阻塞 6 分钟×2
- 2026-08-15：全量回归 until_exit 阻塞 420 秒（命令尾部 bash 仍存活会话不退出，until_exit 注定等满超时）

## 旧命令名（已移除，禁止引用）

/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart

## 旧扩展名（已融合/更名，禁止引用）

pi-web-toolkit / pi-router / pi-admin / pi-scheduler