# AGENTS.md 细节索引（按需加载）

本文件承接 AGENTS.md 移出的细节，需要时 read 本文件（通常一次 <1K token 即命中所需段落）。

## 元信息

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 更新日期 | 2026-09-12 |
| 适用范围 | AGENTS.md 细节索引、目录结构详情 |
| 相关文档 | [AGENTS.md](../../agent/AGENTS.md), [AGENTS-DETAILS.md](./AGENTS-DETAILS.md) |

---

## 目录

- [一、目录结构详情](#一目录结构详情)
- [二、回归验证细节](#二回归验证细节)
- [三、缓存治理](#三缓存治理)
- [四、补丁生命周期](#四补丁生命周期)
- [五、已知噪音](#五已知噪音)
- [六、后台任务阻塞教训](#六后台任务阻塞教训历史)
- [七、工具分层与优化指南](#七工具分层与优化指南)
- [八、旧命令名](#八旧命令名已移除禁止引用)
- [九、旧扩展名](#九旧扩展名已融合更名禁止引用)

## 目录结构详情

### agent/

#### Layer 0: 基础层（core/）

零依赖的基础工具，被所有上层模块引用：

- `core/config.ts` — 配置加载/合并（loadPiConfig, loadExtensionConfig, mergeLayers）
- `core/registry.ts` — 注册/清理统一封装（withRegistry, registerTool, registerSlashCommand）
- `core/hook-registry.ts` — 扩展钩子注册表（extensionHooks）
- `core/secrets.ts` — 密钥脱敏工具（scrubSecrets, SECRET_PATTERNS）
- `core/index.ts` — 统一导出

#### Layer 1: 服务层（services/）

核心服务，仅依赖 core/：

- `services/token-budget/` — Token 预算管理
  - `context-budget.ts` — 统一 Token 预算/估算/裁剪 + 缓存命中统计
  - `prune.ts` — 工具输出裁剪（PRUNE_PROTECT_TOKENS=120K, PRUNE_MINIMUM_TOKENS=80K）
  - `auto-compact.ts` — 自动压缩触发策略
  - `output-archive.ts` — 工具输出归档（写入时预算截断的原文落盘 logs/tool-outputs/）
  - `index.ts` — 统一导出
- `services/diagnostics/` — 诊断服务
  - `usage-diag.ts` — 用量诊断（/usage-diag 数据源，MAX_LINES=20000 自动截断）
  - `task-record.ts` — 结构化任务记录（logs/task-records.jsonl）
  - `index.ts` — 统一导出
- `services/shadow-review.ts` — 影子代码审查
- `services/note-store.ts` — ctx-lite 笔记持久化
- `services/index.ts` — 统一导出

#### Layer 2: 扩展层（extensions/）

12 个独立扩展，每个扩展自包含：

- `pi-context/` — Token 优化中枢（已融合 pi-router）
  - `scripts/` — 核心基础设施（rebuild.sh/test-all.sh/daily-health.mjs/pi-wrapper.sh/usage-stats.mjs/task-summarizer.mjs/check-cache-impact.sh），扩展专用脚本需在各自 extension/scripts/
  - `tests/` — 92 用例
- `pi-autopilot/` — 自主运行（定时任务 + 自管理 + 失败自愈）
  - `config/` — .pi-autopilot-config.json, notify.json
  - `scripts/` — knowledge-fetch, ntfy-relay, pi-cron, pi-notify, task-metrics
  - `tests/` — 106 用例
- `pi-memory/` — 跨会话持久记忆
  - `scripts/` — memory-lifecycle
  - `tests/` — 94 用例
- `pi-web-search/` — 网络搜索（SearXNG + Bing + HTTP）
  - `tests/` — 75 用例
- `pi-browser/` — 浏览器自动化（CloakBrowser）
  - `scripts/` — patch-playwright-core
  - `tests/` — 25 用例
- `plan-mode/` — 计划模式（TUI 计划/任务管理）
  - `scripts/` — patch-plan-tools
  - `tests/` — 72 用例
- `pi-tmux/` — tmux 会话管理
  - `scripts/` — pi-bg, tmux-fix
  - `tests/` — 20 用例 + 2 跳过
- `pi-voice/` — 语音交流（Termux）
  - `config/` — pi-voice.json
  - `scripts/` — pi-whisper, pi-sherpa, whisper-server, patch-voice-enter
  - `tests/` — 128 用例
- `pi-link/` — 多设备互联
  - `config/` — pi-link.json
  - `scripts/` — pi-link-entry, pi-link-keys
  - `tests/` — 58 用例
- `pi-intervention/` — 干预捕获
  - `tests/` — 5 用例
- `pi-mode/` — 模式切换
- `subagent/` — 子代理
  - `tests/` — 63 用例 + 7 vitest guards

跨扩展检查：

- `extensions/tests/conflict-check.mjs` — 9 项：注册冲突/工具指纹入账等
- `extensions/tests/cache-guard.mjs` — 缓存注入面守门（注入面 sha256 基线 + prune 阈值契约 + 动态源扫描）

#### Layer 3: 技能层（skills/）

6 个内置技能：

- `pi-translate-zh/` — 中文翻译
- `pi-backup/` — 备份恢复（本地归档 + GitHub 同步）
- `pi-code-review/` — 代码审查（确定性检查 + 分级报告）
- `pi-bug-diagnosis/` — 硬 bug 诊断纪律
- `pi-full-audit/` — 全项目深度审计
- `pi-repo-optimize/` — 配置仓库结构/存储/架构优化

#### Layer 4: Agent 编排层

- `agents/` — 子代理模板（scout.md, worker.md, reviewer.md）
- `prompts/` — pi 全局 prompt templates（*.md 自动注册为 /name 斜杠命令）

#### 兼容层

- `lib/` — 兼容层（保留 2 周，2026-09-23 清理）
  - `index.ts` — 重导出 core/ + services/

#### 其他

- `settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `stats/` — 运行时统计（git 忽略）：`usage-sessions.jsonl`（跨会话命中聚合）、`tool-fingerprint.jsonl`（工具定义指纹历史）
- `package.json` — 统一依赖根（12 扩展共享 agent/node_modules）

### scripts/

核心基础设施脚本（保持在 scripts/ 根目录）：

- `rebuild.sh` — 一键重建（幂等、并行下载、国内镜像加速）
- `test-all.sh` — 一键全量回归（含 cache-guard 注入面守门）
- `install/` — 安装脚本（cron/systemd/wrapper）
- `utils/` — 工具脚本（smoke-test/pi-bench/docker-rebuild-test 等）
- `verify-patches.mjs` — 补丁版本校验

扩展专用脚本（symlink 到 scripts/ 供外部发现）：

- `pi-cron.sh` → `agent/extensions/pi-autopilot/scripts/pi-cron.sh`
- `task-metrics.mjs` → `agent/extensions/pi-autopilot/scripts/task-metrics.mjs`
- `tool-stats-sync.mjs` → `agent/extensions/pi-context/scripts/tool-stats-sync.mjs`
- `usage-stats.mjs` → `agent/extensions/pi-context/scripts/usage-stats.mjs`
- `task-summarizer.mjs` → `agent/extensions/pi-context/scripts/task-summarizer.mjs`
- `patch-*.mjs` → `agent/extensions/*/scripts/patch-*.mjs`

### data/（运行时数据）

- `memory/` — pi-memory 长期记忆（entries.json 入库共享，其余 git 忽略）
  - `entries.json` — 2 MB 上限
  - `notes.json` — 便笺
  - `summaries.json` — 会话摘要
  - `checkpoints/` — 检查点（瞬时快照，不入 git）
- `logs/` — 运行时日志
  - `scheduler/` — 离线执行日志（自动清理，不 git 跟踪）
  - `task-records.jsonl` — 结构化任务记录
- `plans/` — plan-mode 计划存档（每计划独立 .git，供计划内 git 操作）

兼容 symlink（2026-09-23 清理）：

- `memory/` → `data/memory/`
- `logs/` → `data/logs/`
- `plans/` → `data/plans/`

### docs/（文档）

按职责分类：

- `design/` — 设计文档（VISION.md, MODULARIZATION-PLAN.md, SELF-OPTIMIZING-*.md）
- `development/` — 开发文档（AGENTS-DETAILS.md, PI-EXT-DEV-NOTES.md, PI-SDK-EXTENSION.md, GIT-HISTORY-REWRITE.md）
- `operations/` — 运维文档（ENVIRONMENTS.md, TERMUX-DEV-NOTES.md, alacritty-tmux-setup.md）
- `maintenance/` — 维护文档（OPTIMIZATION-LOG.md, SKILLS-MAINTENANCE.md）

### deploy/ 与 searxng/

- `deploy/systemd/` — unit 模板
- `deploy/tmux/` — tmux.conf 与状态脚本
- `extensions/pi-link/keys/` — pi-link 公钥合集
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）

### packs/（统一外部技能仓库）

- `packs/<name>/` — 已确认技能包（SKILL.md 入口 + bin/ lib/ references/ workflows/ 等资源）
- `packs/drafts/` — 草稿（待人工确认，不入 agent/skills/ 防提示词膨胀）
- 详见 `packs/README.md`

### portable/（便携 pi，Windows 原生种子）

- `bin/` — setup/verify/diag/update-pi/update-portable/sync/check-restart/check-services/searxng-setup/whisper-setup 等管理脚本
- start.bat/start.ps1 入口、ca-bundle.crt、tools/tmux shim
- 完整经验见 `portable/README.md` 与记忆条目「便携 pi Windows 最终架构」

## 回归验证细节

单套件：`cd agent/extensions/<ext> && ../../node_modules/vitest/vitest.mjs run`（统一依赖根 agent/node_modules）
（基线用例数：pi-web-search 75+ / pi-memory 94+ / pi-autopilot 106+ / pi-browser 25+ / pi-context 92 / plan-mode 72 / pi-tmux 20+2 跳过 / pi-voice 128+ / pi-link 58 / pi-intervention 5，另 subagent vitest guards 7 用例；以 test-all.sh 当前输出为准）

注册面：`cd agent/extensions/pi-web-search && ../../node_modules/vitest/vitest.mjs run tests/extensions.test.ts`
（须在该目录跑使 mock alias 生效；顶层跑 subagent 用例会因真实包加载超时）

subagent 双轨：mjs 测试 `cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs`；另有 vitest 套件（vitest.config.ts + tests/subagent-guards.test.ts），随 test-all.sh 的 11 套 vitest 统一跑

类型检查：`cd agent/extensions && ../node_modules/typescript/bin/tsc -p tsconfig.local.json --noEmit`
（必须 local.json——共享 tsconfig.json 的 paths 为空会全量报 Cannot find module；缺失时回退共享配置）

## 缓存治理（2026-08-18，append-only 原则）

对齐 Reasonix/Orca 99%+ 命中实践（不动老消息）：

- `services/token-budget/prune.ts` 阈值 = 缓存契约：`PRUNE_PROTECT_TOKENS=120K`（分层擦除保护带）、`PRUNE_MINIMUM_TOKENS=80K`（最低回收）、`DEFAULT_KEEP_THINKING_TOKENS=64K`（thinking 剪枝）——1M 窗口内普通会话全程不触发，清理交给 auto-compact；阈值回退会被 cache-guard 阻断
- 历史背景：16K thinking 预算曾致 3.8h 会话 27 次缓存断裂、1.46M token 浪费（每 2-3 轮改早期消息 → 前缀断裂）；64K 后模拟断裂 39→4 次，实测 0 断裂/98%+
- 工具 schema 是 system prompt 一部分：conflict-check 每次运行将 registerTool 块 sha256 入账 `stats/tool-fingerprint.jsonl`，跨会话漂移可追溯
- 诊断：`node agent/extensions/pi-context/scripts/usage-stats.mjs` 看每会话命中/断裂/浪费；断裂轮 cacheRead ≈ 断裂点，对照该轮事件定位；`cache-guard.mjs` 查注入面漂移
- 流程层守门（2026-08-26，源自 dsh 生态 Reasonix 纪律）：`scripts/maintenance/check-cache-impact.sh` 经 `.githooks/commit-msg`（rebuild 自动配 `core.hooksPath`）强制触碰缓存敏感面的 commit 携带 `Cache-impact: <none|low|medium|high> - <理由>`；触碰 `agent/{skills,prompts,agents}/` 追加 `System-prompt-review:`（拒绝 none/占位）。手动报告：`bash scripts/maintenance/check-cache-impact.sh --staged`。与 cache-guard.mjs 分工：指纹管内容漂移，声明管流程纪律

## 补丁生命周期

`patch-voice-enter.mjs`（回车拦截，缺失时 pi-voice 自动禁用回车听写）
`patch-footer-live-context.mjs`（footer 实时 token）
`patch-footer-cache.mjs`（footer CH 双命中率实时/会话 + context 去百分比；依赖前者的实时 context 形态）
`patch-footer-format.mjs`（footer 前 3 字段符号 Σ/↑/↓ + 成本人民币；依赖 cache 补丁之后的形态）
`patch-footer-restart-hint.mjs`（上下文 >40% 窗口时 context 区追加 ⚠，提示重启前先压缩；依赖 cache 补丁的实时 context 形态）
`patch-plan-tools.mjs`（--continue 恢复会话的工具 schema）
`patch-tab-arg-completion.mjs`（tab 参数补全）
`patch-autocomplete-startswith.mjs`（autocomplete value.startsWith 类型守恒）
`patch-fuzzy-match-type.mjs`（fuzzyMatch text.toLowerCase 类型守恒）
`patch-truncate-type.mjs`（truncateToWidth text.slice 类型守恒）
`patch-compaction-warm-prefix.mjs`（压缩摘要暖前缀重放）
`patch-playwright-core.mjs`（Termux android→linux 平台补丁）

共 12 个 patch 文件由 rebuild.sh 自动执行（幂等）：11 个无条件 + `patch-playwright-core.mjs` 仅 Termux 条件执行；pi update 升级 dist 后需重跑 rebuild.sh（或手动 node 执行对应脚本）。

补丁文件位置：`agent/extensions/*/scripts/patch-*.mjs`（rebuild.sh 直接读取各扩展 scripts/ 目录）

footer 状态栏口径速查：`Σ/↑/↓`=会话累计（Σ=总输入=命中+未命中 / ↑=累计未命中输入 / ↓=累计输出）；`CH{x}/{y}%`=左实时（最近一轮）/右会话累计；context 区 `34.5k/200k`=实时/窗口（>40% 追加 ⚠ 提示重启前先压缩、>70% 黄、>90% 红，无括号百分比）；`¥`=成本人民币（参考汇率 6.77=2026-08 近 90 天中位数，常量在 patch-footer-format.mjs，改汇率后重跑自动更新 dist）。

重启/压缩策略（2026-08-17 对齐 DeepSeek Harness dsh 源码结论）：
- **日常压缩阈值** thresholdRatio 0.8（dsh compaction-basic 同值，晚压缩更优；verbatim tail 由 pi 内核 keepRecentTokens=20000 实现，同 dsh retainRatio 0.16 思路）
- **重启/恢复阈值** 100K（`PI_CONTEXT_RESTART_TOKENS` 可覆盖；原 40% 窗口比例 `PI_CONTEXT_RESTART_RATIO` 已移除）：`session_start` 读取 pi-autopilot state action，仅看门狗 `restart_hang`（空闲挂死重启，maxIdleMinutes=180）触发提前压缩——重启后首轮必然全量重发，>100K 先压更省；手动/正常重启不压缩。admin_restart 工具超阈值前会 warning 提示先 /compact（详见 pi-context/README.md「重启/恢复压缩阈值」节）
- **dsh 调研要点**（npm 包 @deepseek-ai/dsh 0.1.0-rc.7 源码）：无显式缓存优化代码，缓存友好是架构默认——静态 persona（{{model}}/{{cwd}} 启动时解析一次，无时间戳）、compaction 阈值 0.8+retainRatio 0.16、token-meter 按 input+cacheRead+cacheWrite 算压力。我们已全部对齐/超额。
- **自动重启间隔**：看门狗 maxIdleMinutes 由用户改为 180（3 小时，.pi-autopilot-config.json；types.ts 默认同步），挂死判定放宽避免误杀长思考。

补丁恢复保障：pi update 经 pi-wrapper.sh L3 拦截（CLI 一次性命令），成功后自动重跑 rebuild.sh 恢复全部补丁；手动 `bash scripts/rebuild.sh` 同样幂等可恢复。

## 已知噪音（勿误判为 bug）

pi 启动时可能打印 `Extension shortcut conflict: 'return'/'shift+enter' is built-in shortcut for tui.input.newLine and .../pi-voice/index.ts. Using .../pi-voice/index.ts.`

这是 pi-voice 故意注册回车键（`Key.return` + `Key.shift('enter')`，enter 本身是保留键会被静默丢弃）用于录音中切段转写，与内置 `tui.input.newLine` 冲突属设计行为（restrictOverride=false，扩展生效）。功能安全由 patch-voice-enter.mjs 保证（未录音时 handler 返回 false 放行回车）。扩展 API 无注销接口，无法消除该警告，无需处理。

## 后台任务阻塞教训（历史）

- 2026-08-14：rebuild 任务 tmux_wait 连续阻塞 6 分钟×2
- 2026-08-15：全量回归 until_exit 阻塞 420 秒（命令尾部 bash 仍存活会话不退出，until_exit 注定等满超时）
- 2026-08-22 已修复：core.ts 注入命令尾部追加 `; [ $? -ne 130 ] && exit`——命令自然结束（成功/失败）会话自动退出，notify 自动唤醒与 until_exit 均恢复正常；Ctrl-C 中断（退出码 130）保留 shell 供继续交互

## 工具分层与优化指南（2026-09-09）

### 工具分层架构

Pi 使用三层工具架构，按使用频率和重要性分层：

| 层级 | 说明 | schema 注入 | 示例 |
|------|------|-------------|------|
| **L0 核心** | 每轮必需的工具 | 每轮完整注入 | read, bash, edit, memory_store |
| **L1 休眠** | 按需启用的工具 | 不注入，需 `enable_tool()` | browser-core, admin, autopilot |
| **L2 完整** | 低频/高级工具 | 不注入，需显式启用 | browser-full, verify, link |

### 核心工具选择原则

**保留核心的标准：**
1. **高频使用**：30 天内调用 ≥10 次
2. **功能独特**：无法被其他工具替代
3. **核心能力**：文件操作、用户交互、重启等基础能力
4. **Schema 极小**：如 admin_restart（<100 token）

**移入休眠的标准：**
1. **低频使用**：30 天内调用 <5 次
2. **可替代**：功能可由 bash/脚本/其他工具替代
3. **专业场景**：仅特定工作流需要（如验证器开发）
4. **Schema 较大**：占用大量 token 但使用率低

### 当前工具分组（2026-09-09）

**核心常驻（21 工具）：**
- 文件操作：read, bash, edit, write, grep, find, ls（7）
- 规划：todo, plan_exit（2）
- 子代理：subagent（1）
- 记忆：memory_store, memory_search, memory_forget, ctx_exec（4）
- Web：web_search, fetch_url（2）
- Tmux：tmux_run, tmux_read, tmux_stop（3）
- 管理：admin_restart（1）
- 交互：ask_user（1）

**休眠组（11 组，45 工具）：**
- plan（1）：plan_enter
- browser-core（3）：navigate, evaluate, click
- browser-advanced（3）：wait_for, network, find
- browser-full（12）：screenshot, type, scroll, extract, select_option, dialog, download, upload, cookies, close, pdf, help
- memory-advanced（5）：ctx_note, ctx_list, ctx_snap, memory_recall, memory_stats
- tmux-advanced（3）：status, send, wait
- admin（7）：status, list_models, set_model, get_config, set_config, list_sessions, switch_session
- autopilot（5）：status, stats, policy, failover, schedule_task
- verify（3）：report, config, test
- link（2）：send, status
- web-fallback（1）：web_fetch

### 新增工具规范

**添加新工具前必须回答：**
1. 这个工具解决什么问题？能否用现有工具组合解决？
2. 预期使用频率是多少？（高/中/低）
3. Schema 大小是多少 token？
4. 是否有独特的 API/能力，无法被 bash/脚本替代？

**新工具默认分类：**
- 未在 CORE_TOOLS 或 SLEEPING_GROUPS 中的工具自动归为核心（computeActiveTools 逻辑）
- 新扩展应显式将其工具加入 SLEEPING_GROUPS，避免自动归为核心

**添加流程：**
1. 在扩展的 tools.ts 中注册工具
2. 在 tool-groups.ts 的 SLEEPING_GROUPS 中添加分组
3. 如果是高频工具，考虑加入 CORE_TOOLS
4. 更新相关文档

### 缓存友好约束

1. **工具列表变化 = 前缀缓存断裂**：enable_tool() 是低频操作，会话内保持固定
2. **禁止每轮动态启停**：会导致每轮缓存重算
3. **启用状态是进程内存态**：pi 重启后恢复默认分层
4. **休眠组简介是静态的**：buildSleepingSummary() 内容不依赖启用状态

### 工具使用统计

统计文件：`data/stats/tool-count-<device>.json`
同步脚本：`scripts/tool-stats-sync.mjs --daily`

**分析维度：**
- 30 天调用次数
- 首末使用时间
- 跨设备使用情况

**优化决策依据：**
- 调用次数 <5 → 考虑移入休眠
- 调用次数 =0 → 考虑移除或保留（检查功能独特性）
- 调用次数 >10 → 考虑提升为核心

## 旧命令名（已移除，禁止引用）

/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart

## 旧扩展名（已融合/更名，禁止引用）

pi-web-toolkit / pi-router / pi-admin / pi-scheduler
