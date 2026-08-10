# Pi 项目环境描述（/root/.pi）

Pi 本地配置仓库：自定义扩展、共享库、技能、自托管 SearXNG、生命周期脚本。

## 目录结构

- `agent/settings.json` — Pi 主配置（provider/model/extensions/skills；含密钥，git 忽略）
- `agent/extensions/` — 9 个已注册扩展：subagent / pi-context / plan-mode / pi-autopilot / pi-memory / pi-web-search / pi-browser / pi-tmux / pi-voice
- `agent/lib/` — 共享库：`context-budget.ts`（统一 token 预算/估算/裁剪/缓存统计）、`auto-compact.ts`（按窗口比例自动压缩阈值+防抖+压缩后自动继续门）、`prune.ts`（兼容层 + 工具输出分层擦除 + thinking 预算保留）、`usage-diag.ts`（每轮 LLM 用量诊断记录/汇总，含 prune/压缩事件）、`note-store.ts`、`token-budget.ts`（兼容层）
- `agent/prompts/` — 提示词文档（PI-SDK-EXTENSION.md）
- `agent/agents/`、`agent/skills/` — 子代理模板与技能
- `scripts/` — rebuild.sh 一键重建、pi-wrapper.sh 生命周期、pi-cron.sh 定时、test-all.sh 回归、pi-whisper.sh whisper 转写服务管理（配套 `whisper-server.py`，faster-whisper 常驻于 127.0.0.1:18766；模型经 hf-mirror.com 下载，缓存 /opt/pi-whisper/models）、patch-voice-enter.mjs 回车拦截核心补丁（rebuild.sh 自动幂等执行；**未打补丁时回车键会被 pi-voice 无条件吞掉**——扩展到全局拦截 enter，输入提交/菜单选择失效。pi-voice 启动时检测 MARKER，缺失则自动禁用回车听写并提示，避免吞回车）、patch-footer-live-context.mjs footer 实时 token 补丁（同 rebuild.sh 自动执行）、patch-plan-tools.mjs 工具 schema 恢复补丁（见 plan-mode 段说明）
- `searxng/` — 自托管搜索（settings.yml 含密钥，git 忽略；venv/repo 可重建）
- `memory/` — pi-memory 运行时数据（git 忽略）
- `logs/whisper/` — whisper 服务日志与 pid（运行时数据）

## 语音交流（pi-voice 扩展，Termux/Android 环境）

pi-voice 提供双向语音：`/voice` + `Ctrl+Shift+R` 录音（termux-microphone-record）→ ffmpeg 转 16k wav → 本地 faster-whisper 常驻服务（`~/.pi/scripts/pi-whisper.sh start`，端口 18766）转写 → 插入输入框或直发；`message_end` 事件自动朗读 assistant **最终回复**（termux-tts-speak，中文系统 TTS）。**TTS 语义（2026-08 全面调整）**：默认关闭（持久化 false，非语音状态不朗读）；语音输入（开始录音/语音直发）自动开启、键盘输入自动关闭（`input` 事件 `source` 区分 interactive/extension），手动 `/tts on|off` 后不再自动切换；只朗读 `stopReason=stop` 的消息，`isSpeechWorthy` 过滤 JSON/结构化摘要；**串行队列合并**（`createTtsDispatcher`）：同时只朗读一条、新文本替换待读旧文本——解决 2026-08 实测 TTS 朗读每轮文本+JSON summary 产生 50+ 个永不退出的 termux-tts-speak 僵尸进程（Android TTS 引擎队列塞满、实际听不到声音）。**TTS 进程堆积清理：`pkill -f termux-tts-speak; pkill -f 'termux-api TextToSpeech'`**（扩展启动时自动执行，且启动时 `cleanupStaleAudio(config, 0)` 清空 tmpDir 全部残留——进程重启后必然无进行中录音）。录音/转写中键盘输入被 `input` 事件拦截提示；听写回车 800ms 防抖；转写/朗读/自动转写成功失败均有明确提示（notify/sendMessage display）。`transcribe` 前自动 `ensureWhisperService`（health 检查→不在线自动 pi-whisper.sh start→轮询 120s 就绪；依赖可注入单测）。`/voice doctor` 诊断依赖（带 token 鉴权，配置 token 后 401 会明确报 token 不一致）。配置：环境变量或 `~/.pi/agent/pi-voice.json`，见扩展 README。注意：麦克风权限需在 Android 设置授予 Termux:API；HuggingFace 下载须走 hf-mirror.com（`HF_ENDPOINT` + `HF_HUB_DISABLE_XET=1` 已固化在 whisper-server.py）。

## 验证命令（全量回归）

```bash
bash scripts/test-all.sh          # 一键：10 套测试（8 vitest + subagent + 注册面）+ tsc + conflict-check
```

单套件：`cd agent/extensions/<ext> && ./node_modules/.bin/vitest run`（pi-web-search 72 / pi-memory 53 / pi-autopilot 89 / pi-browser 23 / pi-context 39 / plan-mode 51 / pi-tmux 10 / pi-voice 52 用例）
注册面：`cd agent/extensions/pi-web-search && ./node_modules/.bin/vitest run tests/extensions.test.ts`（23 用例，须在该目录跑使 mock alias 生效；顶层跑 subagent 用例会因真实包加载超时）
subagent 无 vitest：`cd agent/extensions/subagent && node --experimental-strip-types --import ./tests/loader.mjs ./tests/test.mjs`（34 用例）
类型检查：`cd agent/extensions && ./pi-web-search/node_modules/.bin/tsc -p tsconfig.json --noEmit`
扩展冲突：`cd agent/extensions && node tests/conflict-check.mjs`（8 项）

## 关键约定

- **扩展注册**：pi 0.83+ 从 `~/.pi/agent/extensions/` 目录自动发现扩展，settings.json 的 extensions 数组仅作覆盖模式（`!` 排除 / `+` 强制包含 / `-` 强制排除），不再承担注册职责；新扩展须同步目录 index.ts、extensions/tsconfig.json include、tests/conflict-check.mjs 监听者清单、extensions.test.ts
- **扩展命令整合规范**（2026-09，conflict-check.mjs 第 2/2b 项守门）：同一扩展的 slash 命令必须整合为 ≤2 个，具体功能用子命令参数指定（终端程序风格），并支持 `help`/`-h`/`--help` 子命令输出用法；命令 description 应包含子命令清单与 `/xxx help` 提示（这是 `/` 菜单唯一展示面）；子命令补全用 `getArgumentCompletions`（框架级支持）。当前命令面：`/voice <start|stop|cancel|tts|doctor|model|bench|help>`（含 tts 朗读）、`/auto <status|policy|failover|pause|resume|restart|help>`、`/schedule`（14 子命令，独立）、`/plan <enter|exit|clear|resume|view|todos|help>`（无参数=切换，兼容旧行为）、`/memory`、`/usage-diag`。旧命令名（/tts、/planclear、/planresume、/planview、/todos、/auto:*、/admin:restart）已移除，文档与提示文案已同步。新增命令若未同步 conflict-check.mjs 清单会直接报错。
- **缓存友好**：system prompt 注入禁止时间戳与精确数值；压力提示按档位（相对 auto-compact 阈值：<75% 不注入、≥75%/≥90% 固定文案）；共享估算统一用 `lib/context-budget.ts` 的 `estimateTokens`
- **自动压缩**：pi 内置压缩阈值 = 窗口 − reserveTokens，对 1M 窗口模型高达 96.7 万形同虚设；由 pi-context 按窗口比例触发（>256K 窗口 40% / ≤256K 85%）：agent_end 判定 + session_start 恢复时立即压缩（resume 大会话避免首轮全量浪费）；阈值计算与防抖见 `lib/auto-compact.ts`；ctx.compact() 会 abort 当前 agent 且不 await 完成（扩展 API 为 void + onComplete 回调），故判定放 agent_end、压缩完成由 session_compact 事件通知；`AutoContinueGate` 在压缩完成后自动注入继续指令（triggerTurn:true 启动新一轮），180s cooldown 防递归；阈值依据 2026-08 长任务实测（缓存命中率 86%、命中价 1/50 → 晚压缩成本更低）
- **分层擦除**：pi-context 在 context 事件阶段做工具输出事后擦除（借鉴 opencode prune）：最近 2 轮 + 40K token 保护带内保留，更早的 toolResult 输出替换为 `[pruned]` 占位（保留结构），预计回收 ≥20K 才应用；判定确定性、擦除点单调后移，缓存前缀稳定；见 `lib/prune.ts`
- **工具输出截断**：tool_result 事件写入时截断——bash/read 5KB（bash 保留尾部、read 保留头部），其他工具 20KB 兜底；thinking 保留最近 16K token（token 预算而非轮数规则，见 `lib/prune.ts pruneThinkingBudget`）
- **执行效率注入**（pi-context `EFFICIENCY_ADVICE`，静态缓存友好）：要求模型一轮内批量发出独立工具调用（内核 agent-loop.js 已支持 parallel batch）、非终轮不写解释文本、todo/plan 摘要请求时例外。实测（2026-08，reverse-skill 全面分析同任务同模型）：请求 36→11、totalTokens 1.06M→329K、费用 ¥0.128→¥0.057，且低于 opencode 同任务（¥0.11）；模型保持每轮 2 工具批量、末轮一次性总结
- **plan-mode subagent 开放**（参考 opencode explore 只读子代理）：已启用——2026-08-09 曾撤回（实测 subagent 工具在 TUI 会话未进 registry，`Tool subagent not found`），恢复注册后重新加入白名单；`assertPlanSubagentAllowed`（utils.ts）在 tool_call 拦截处强制仅允许 `agent="scout"`（worker/reviewer/未指定均拦截，防落可写 general-purpose）。当前 plan 白名单：read/bash/grep/glob/todo/web_search/fetch_url/subagent/plan_exit；执行模式白名单：read/bash/edit/write/todo/web_search/fetch_url/subagent/plan_enter（fetch_url 为只读 HTTP GET，与 opencode explore 允许 webfetch 的思路一致；plan_enter/plan_exit 为模型侧切换工具——进入无需确认（只读），退出弹 ctx.ui.select 确认选择器、用户确认后才生效，与 opencode plan_exit 用户询问语义一致）。**工具 schema 恢复补丁（patch-plan-tools.mjs，2026-08-10）**：--continue 恢复会话的模型函数调用 schema 不含重启后新注册工具（plan_enter/plan_exit 不可调用，tool_calls 记录 0 次，--print 新进程正常）——内核缺陷（prepareNextTurnWithContext 注入旧快照）。补丁在 core/agent-session.js 的 tools 注入处检测并调用 _refreshToolRegistry 刷新。**决策记录：若后续不需要模型侧主动切换（用户 Ctrl+Alt+P//plan 切换已完整），移除补丁即可回退方案 2**。注意：如 TUI 会话再报 `Tool subagent not found`，说明 subagent 扩展未注册成功，需排查扩展加载而非白名单（2026-08-09 修复：此前 PLAN_MODE_TOOLS/NORMAL_MODE_TOOLS 均未含 todo，与注入提示"必须调用 todo 工具"自相矛盾——plan 与执行模式模型都无法调用 todo，只能文本跟踪；已把 todo 加入两个工具集）
- **plan-mode bash 白名单解析**（isSafeCommand）：剥离并放行 `cd <dir> && <单条白名单命令>` 与尾部 `2>/dev/null`；多命令/管道/多重 &&/重定向至文件/命令替换一律拒绝。依据 2026-08 实测：模型习惯复合命令致单会话 12+ 次无效拦截；提示词已同步说明并给出 git ls-remote/log/status 替代 clone
- **用量诊断**：`/usage-diag` 显示每轮 input/缓存/输出汇总 + prune 擦除量 + 压缩触发（记录在 `~/.pi/agent/.usage-diag.jsonl`，仅展示不进 LLM 上下文）；扩展的异步回调不得使用捕获的 ctx（session 替换后 stale ctx 抛错），需先取值
- **footer 口径**（`dist/modes/interactive/components/footer.js`）：`↑↓RW$` 为整个会话文件累计消耗（含已压缩历史与 compaction 摘要 usage，压缩后不变）；context 为实时上下文（`getContextUsage`，基于最近有效 assistant usage + 尾部估算，压缩后为 `?` 直到下轮响应）。补丁 `scripts/patch-footer-live-context.mjs`（幂等）把实时 token 并入显示：`34.5k/200k (17.2%)`；rebuild.sh 自动执行，pi update 后重跑 rebuild.sh 即可
- **补丁生命周期**：`patch-footer-live-context.mjs`/`patch-voice-enter.mjs`/`patch-plan-tools.mjs` 均由 rebuild.sh Phase 3 自动执行（幂等，MARKER 跳过）；pi update 升级 dist 后需重跑 rebuild.sh（或手动 node 执行三个脚本）。patch-voice-enter 缺失时 pi-voice 会禁用 Key.enter 注册（保护回车），patch-footer 缺失仅影响显示，patch-plan-tools 缺失则恢复会话模型无法调用新注册工具（可用用户侧快捷键切换兜底）
- **plan-mode 修订语义**：`mergePlanRevision`（utils.ts）——修订时未完成任务按 subject 匹配（规范化相等 → 子串包含 → Dice≥0.6 兜底）：匹配保留原 id/状态，未匹配 pending 移除、in_progress 降 pending（清 activeForm）、blocked 保留，completed/deleted 始终保留；不再重复 append 堆积任务。修订意图判定：**只看最后一条用户消息**（`isPlanRevisionIntent`），assistant 汇报/总结文本即使含编号列表与"修订"等词也不触发（2026-08 实测误触发：汇报文本被 `**plan-mode 修订语义**` 中的 plan 撞上 Plan 头正则提取成任务；plan-revise 消息副本被用户转发后含"修订"词再次触发——已加 `**计划已修订/进度/步骤/完成` 前缀过滤）；Plan 头正则已收紧为须后跟冒号/空白/行尾（`\*{0,2}(?:Plan|计划)\*{0,2}(?:[:：]|\s|$)`），`计划步骤 (0/9)` 类聊天展示行不提取。注入的 plan prompt 强制用 todo 工具跟踪步骤（文本 Plan 仅展示）
- **plan-mode 缓存特性**：注入消息（plan-execution-context/todo-list/progress 等）均追加在消息流尾部，且 context 阶段按 customType 只保留最新一条——更新时仅使被删旧注入消息（约 100–500 token）失效，对前缀命中率影响 <0.3%；若注入消息累积在消息中部，删除会使其后全量失效，故单实例过滤必须保留
- **git push**：remote 含 token 时先 `git remote set-url origin` 恢复无凭证 URL；勿提交 auth.json/settings.json/models.json（已 git ignore）
- **旧扩展名残留**：pi-web-toolkit / pi-router / pi-admin / pi-scheduler 均已融合或更名，新代码禁止引用

## tmux 集成（pi-tmux 扩展 + 用户使用）

- **后台任务（pi-bg.sh）**：长任务不想阻塞前台对话时，用 `~/.pi/scripts/pi-bg.sh start|rpc <name> <prompt>` 在 tmux 里跑 headless pi（`-p` 一次性 / `--mode rpc` 长驻，`prompt`/`steer` 注入指令，`status`/`log`/`stop` 管理），四件套隔离（`--no-session` + `--no-extensions` + 默认只读 `--tools` + 独立日志 `~/.pi/logs/bg/<name>.log`）避免与前台实例的会话/扩展/文件冲突；详见 `~/.pi/scripts/README-pi-bg.md`。

pi 自身 TUI 与 pi-tmux 扩展均基于 tmux 3.4（前缀键 C-a，见 `~/.tmux.conf`）。部署问题与修复见 `alacritty-tmux-setup.md`（WSL2/WSLg、GPU、clipboard、resurrect/continuum 等 7 项）。

- **长任务/交互程序走 pi-tmux 工具**：`tmux_run`（detached + 日志落盘 `~/.pi/logs/tmux/<会话>.log`）、`tmux_read`、`tmux_send`、`tmux_wait`、`tmux_stop`、`tmux_status`；比内建 bash 工具（非交互管道、带 timeout）更适合长任务。会话统一 `pi-` 前缀，pi 退出自动清理（不碰用户会话）。
- **用户手动用法**：`tmux a` 附加；`C-a d` 脱离；`C-a |` 分屏；`C-a C-s` 保存 / `C-a C-r` 恢复（resurrect/continuum）。Alacritty 窗口启动即自动进入 `main` 会话（bashrc 检测）。
- **环境缺失处理**：tmux 未安装时 pi-tmux 工具返回带安装命令的错误（apt/dnf/pacman/brew），模型可按指引安装修复，不崩溃。
- **`access not allowed` 故障**：所有 tmux 命令 stderr 报 `access not allowed` 但 exit 0、会话创建无效 → 陈旧 tmux 服务器（2026-08 曾发现 2023 年启动的进程）导致。2026-08-09 实证根因：proot 环境下 tmux server 被 kill -9 后 **socket 文件残留**（内核不清理），后续所有 tmux 命令报 access not allowed。修复：`kill -9 <tmux pid>` + `rm -rf /tmp/tmux-*` 后重试，无需重启机器。pi-wrapper.sh 已内置 `ensure_tmux` 自愈（每次 pi 启动检测 access not allowed 症状自动清理重建，pi 在 tmux 内时跳过防误杀）
