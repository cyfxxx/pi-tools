# 经验基线（历次审计沉淀，逐次追加）

> 原位于 SKILL.md frontmatter 的巨型单行（YAML 单行难维护）与正文尾部小节，外置至此。
> 每次执行审计后必须把过程经验沉淀到本文件（标注日期+场景）。

- 2026-08-13 /root/.pi 全项目深度审查实战（4 HIGH / 22 MEDIUM 发现，1 项 subagent 方向性误报被人工验证纠正）；同日二次实战：外部 33 条优化建议经 5 组复核子代理逐条核实 → 0 捏造、约 20 准确、12 部分属实、2 处行号错、1 处位置错、3 处同类遗漏，HIGH 中 1 条机制描述错误被纠正降级，1 条"设计当 bug"被驳回；2026-08-14 会话运行巡检实战（缓存命中率 98%+ 实测基准、usage-diag 判定法、注入块 grep 验证的适用性局限——注入不落盘时改用缓存命中率反证、断裂点定位法——systemPrompt 拼入式注入是历史重发根因，pi-memory 改消息注入 + context hook 过滤防累积）；同日缓存验证测试（请求级消息 hash 对比法：usage in 大≠消息断裂，DeepSeek 侧缓存未命中是独立现象；轻量请求 nMsg=4 不影响主请求缓存；修复后记忆变化轮 in=40-92，命中 100%）；同日 dsh 深度分析（deepseek-ai/deepseek-harness 借鉴：注册即 effect、配置分层合并、测试分层、真实运行观察替代 keyless snapshot）；2026-08-14 补充基准工具 pi-bench.sh（usage/timing/compare 三子命令，守护缓存优化不回退）；2026-08-15 全流程实战（50 项发现：1 HIGH / 18 MEDIUM / 19 LOW / 12 同类遗漏，全部修复闭环 6 提交；4 组并行复核首次调用返回空结果→改 2+2 分批重试成功；修复分层执行模式验证：MEDIUM 主会话修 + LOW 三 worker 并行一次成功；scout readonly 化后复核实测改主会话/worker；todo 状态遗漏致 TUI 残留——修复逐项销账纪律；注入块内容质量抽查发现重复/空摘要/截断条目）；同日合并后全量审计（test/portable-win-merge 分支，5 组并行=4 模块+1 文档专项，36 项发现经复核：3 误报纠正/2 部分属实降级/行号普遍 ±20-30，4 HIGH 全修复+回归测试；文档同步 4 处不一致；审计工具自身 bug：review.sh --all 对 ~/.pi 自身失效——排除规则 */.pi/* 误伤扫描根（249 文件只审到 1 个），修复后全量可扫；功能实测维度：扩展真实调用验证（含环境排查：CLOAKBROWSER_BINARY_PATH 从 Termux 泄漏到 WSL 致 pi-browser 启动失败——wrapper 无条件导出 Termux 路径）；2026-08-17 远程合并超严格审计实战（用户强调重要性：合并完整性用 md5 逐文件比对 master vs 分支 + 功能符号 grep，发现 squash 合并只带早期快照——portable-win 46 提交仅早期入 master、pi-browser Windows 便携修复（探测/直连/路径校验）缺失，三点合并移植保留 master 独有修复；subagent 并行 4 组确认每项修复方案，修正 2 处主会话误判：rebase diff 方向看反的 .gitignore 误报、bash 顶层 local 报错但变量仍设置的行为噪音误判；深层审查揪出 d323ab9 审计修复半闭环——fireViaMessage 改语义后 once 任务每小时重复注入永不删除、notifyOnCompletion 死功能、failoverCount 不重置（表面测试通过因只覆盖 subagent 路径），在 agent_settled 补 finalizeInjected 闭环；dsh 优化落地：opencode-go 无 contextWindow 致自动压缩静默失效（getContextUsage 返回 undefined）——resolveContext fallback（turn_end provider tokens + PI_CONTEXT_WINDOW_FALLBACK 1M）+ 0.8 阈值对齐 dsh + 溢出兜底；注入截断质量：truncateByTokens 硬切残句 + 标记预算未扣除（实测超 11 token）——句子边界感知 + TRUNC_MARK_TOKEN_BUDGET 修复；缓存复查：优化后常态命中 99.5%+ vs 历史 86% 基线，断裂三类分类法（重启首轮/注入变化/擦除压缩）；openocde.ai usage 云页访问失败（OAuth/SPA SSR RPC 拿不到）——本地三途径替代（stats/db/usage-diag）。教训沉淀：临时文件 basename 冲突覆盖污染 diff、sed 行号删除后先 grep 验证、合并后验证 master 独有修复未被覆盖、审计语义修正必须检查调用链闭环）；2026-08-18 下午全流程实战（2 HIGH + 15 MEDIUM + 20 LOW + 文档 8 处，0 误报，全部修复闭环；方法沉淀——① BOM/行尾检查用 `od -A n -t x1` 而非 xxd（xxd 在精简环境缺失致 portable 检查误报“无 BOM”）；② summaries/entries 检测脚本须先打印字段结构（首版用 content 字段误报 19 条空摘要，实为 fullText）；③ 组 5 文档专项首轮报告截断→重委派“≤8 条 ≤1200 字”精简版成功；④ 复核子代理本次 2 组并行一次成功（与“4 组返回空→2+2 分批”经验不矛盾，按场景选）；⑤ cache-guard baseline 漂移排查用时间线比对（file mtime vs `git log --format=%ci` vs baseline mtime）确认为有意改动（如 d97788f 缓存治理提交同步改 AGENTS.md）后再 --update-baseline，非回退式改动；⑥ pi-cron 内嵌 Python 段提取验证须截到模块级执行前（try:/tasks= 前），且 compute_next 的 cron 语法须传 task_type=cron（传 interval 得 None 误判）；⑦ 顺带发现新高危 bug：逐小时推进保留分钟（09:59+1h=10:59）使分钟=0 的整点调度被系统性错过一天——阶梯扫描每级推进须归零下级单位；⑧ dom/dow 双限两者连续 continue 结构 bug（dom 匹配时也 continue 跳过 minute 检查）致 dom 受限调度永不触发）


### 2026-08-20 全项目体检
- context 钩子为**链式传递**（内核 dist/core/extensions/runner.js emitContext：handler 返回 messages 喂给下一个），非 last-wins；scout 将“未验证 composer 语义”列为 H1 属过度担忧——此类条目应先在代码定论再定级。
- review.sh 对 node shebang 的 .sh（pi-notify.sh）误报 shell 语法错误：判定前先 head -1 看 shebang，属已知噪声。
- cache-guard 注入面指纹含文件整体（pi-context/index.ts 仅注释改动即触发漂移）：审计注释型改动前先评估基线影响，改动后 --update-baseline。
- 同轮并行 edit+bash 执行顺序不保证，验证性 grep 可能读到编辑前快照——改动验证放独立轮。
- SECRET_PATTERNS 键值形态模式排除集须含 `[`（\x5b），否则二次匹配 `[REDACTED:xxx]` 覆盖强模式结果（storage.test 捕获此回归）。
- 安全修复改命令输出格式（如 session-dir 加引号）会使测试断言失配——先判实现 vs 测试谁对，行为变化同步更新断言。

### 2026-08-24 全项目体检 + 修复闭环
- **多 edit 工具整批原子失败教训**：一次 edit 调用里多个 edits 若其中一个 oldText 不匹配，**整批都不应用**——把 retrieval 的 qualityScore 替换误放进 merge.ts 的调用即因此失败，且拼接出来的 newText 丢了 daysOld 计算行，先读回文件修复再重排。
- **vitest fake timers 默认伪造 Date**：useFakeTimers 下 advanceTimersByTime 会同步推进 Date.now()——pi-voice 看门狗守卫（`Date.now()-spawnAt<8s`）因此在新进程 9s 后照常判定停滞重启，导致 rollover 测试断言 spawn 次数多 1。写 timing 相关断言先想 fake Date 有无参与。
- **append 测试到 describe 之外**：cat >> 追加 it() 到文件尾会落在 describe 闭括号后（顶层），引用不到 describe 局部变量（statuses is not defined）——追加到测试文件必须先看末尾是否 describe 闭合。
- **cache-guard 整文件指纹对注释/逻辑改动敏感**：pi-context/index.ts、lib/context-budget.ts 仅改逻辑/注释即触发基线漂移；确认注入文案未变后 --update-baseline 固化（文案本身与 sleep 阈值/压力提示文本均未触碰）。
- **entries.json 运行时回收 vs 审计误毁**：git diff 出现大量条目删除先 parse 对比可用性——消失条目全带 deleted/superseded 标记即为良性回收，非数据丢失；改善判断脚本（git show HEAD 解析对比活跃 id 集合）值得沉淀。
- **修复回归测试姿势**：H1 损坏备份用 readdirSync 找 .corrupt-* 断言备份存在；M3 pressure 基准用 setCompactThreshold+setUsedTokens 直接可单测；pi-link config 校验新建独立 test 文件即可（loadConfig 可传 path）。
- **审计排查路径**：admin_set_config 白名单接入应先看 safeConfigKeys 定义/quote（config.ts:108），复用不新写。
- 未处理项如实标注：finalizeInjected 竞态无完美信号（window 窄），留守以 roundId 确认的后续优化；pi-voice termux stopRecording 全局 -q 属设备单实例设计，维持现状。

### 2026-08-24（续）压缩策略修订（200K→256K + 完成/后台/空闲三重门）
- **绝对阈值联动破坏面远大于触发点**：改 PI_CONTEXT_ABSOLUTE_TOKENS 不只改压缩触发，还联动 ①压力提示档位 75%/90%（阈值比例）、②thinking 档位基准（computeCompactThreshold 同源）、③plan-mode/context-budget pressure 消费者、④**跨扩展集成测试里写死的档位 tokens**（pi-web-search/tests/extensions.test.ts 将 190K/196K 视为高/临界，256K 下 190K 仅 74% 变低压力）——改阈值必须全仓 grep `200K|200_000|ABSOLUTE_TOKENS` 并把集成测试数据一并重算。
- **tmux 派生子进程可能不带 PI_SESSION_ID 等 env**：依赖该 env 的代码路径，测试若要走"有值"分支必须显式 set 环境变量，否则 tmux 运行与本地 bash 行为不一致（本案例：后台任务门 owner 缺省→宽容放行→断言 flaky）。用 `PI_SESSION_ID=` 清空模拟验证「无 env 分支」，两方向都测。
- **vi.mock('node:child_process')**：整模块 mock 需在 beforeEach 复位（mockReset），且 mockReturnValue 属性（status/stdout/error）要齐全，缺 error 键时 `r.error` 为 undefined 视为成功——两方向断言都覆盖。
- 产品自洽性：pi-tmux 写 owner 与 pi-context 读 owner 同进程同 env，缺省时两边同时缺（宽容放行）不会误判；测试环境单边缺才会 flaky。

### 2026-08-25 全项目审计 + 修复闭环（35 条建议全量复核）
- **并行会话同仓 git 冲突是最大风险源**：审计中途远端出现另一环境/并行会话的 3 个新提交（含 cache-guard 基线更新），pull --rebase 撞出 entries.json 冲突——根因是首个提交混入了之前已 staged 的 memory 文件（git add 只加 agent/ scripts/ 不会清掉 index 里既有的 staged 内容）。**提交前必查 `git status` 的 staged 区**，或提交前 `git reset -q` 清空 index 再精确 add。
- **rebase 冲突后的干净恢复路径**：abort → `reset --soft origin/master` → `reset -q`（unstage 全部）→ 按"我的清单"逐文件 add。soft reset 后 status 会把「本机落后于远端的文件」和「并行会话进行中改动」都显示为 M——**逐个看 diff 方向**：工作区比远端新=进行中工作勿动；比远端旧=落后可 checkout 远端版。
- **cache-guard 基线在多会话下会被互相覆盖**：我 --update-baseline 固化后 checkout 远端 baseline 又把我的指纹覆盖掉，重跑报 3 项漂移。正确顺序：先对齐 AGENTS.md 到远端版 → 再基于当前树 --update-baseline → 验证 ✓ → 一并提交。
- **复核子代理修正审查描述的价值实证**：H1 "仅 9 内置工具、memory 工具全丢" 被复核修正为 "12 项含 memory_search/recall/ctx_note，真正丢失的是 tmux_*/autopilot/admin/browser/memory_store"——不影响 HIGH 定级但修复描述与测试断言必须按修正后事实写，否则注释与实现再度脱节。
- **worker 新测试文件的 tsc 类型坑**：vi.fn() 无泛型时类型为宽型 Mock<Procedure|Constructable>，传给带签名的形参报 TS2345；runTmux.mock 直接访问报 TS2339——统一 `vi.fn<(text: string) => Promise<void>>()` 泛型 + `vi.mocked(fn).mock` 访问。主会话收尾必须跑 tsc（test-all 含 tsc 但定位到文件更快）。
- **新测试用例间的状态污染**：共享 TEST_DIR 的套件里，新用例留下的 pendingInject 标记/.corrupt 文件会让后续既有用例失败——新用例结尾自清理（clearAllPending()/删 .corrupt-*）；写 tasks 文件用 TASKS_FILE 实际常量名（scheduled-tasks.json）而非臆测名。
- **scrubSecrets 返回 string 与 writeJSONAtomic(data: unknown) 组合陷阱**：writeJSONAtomic 内部 JSON.stringify，传 scrub 后字符串会二次 stringify 成带引号文本——需手动 tmp+rename 写 scrub 后字符串。
- **session_compact 仅成功路径 emit**（宿主 dist 两处 emit 均在 appendCompaction 之后，cancel/abort 不 emit）：把"压缩完成"类标记从 session_before_compact 移到 session_compact 是通用修复模式，宿主行为已核实。
- **worker 报告的 git status 描述会互相误指**：3 个 worker 并行改同一仓库，彼此把对方改动当成"工作区已有内容"——抽查 diff 时以文件路径归属判断，不采信 worker 对非自身文件的观察。
- **push 被拒后 stash -u 有副作用**：会把未跟踪目录（packs/drafts 草稿）一并收走，pop 失败（needs merge）后这些文件滞留 stash——恢复用 `git show stash@{0}^3:<path>` 精确取回；已跟踪文件的 D 状态从 origin/master checkout 恢复。

### 2026-08-25（续）「并行会话进行中工作」误判修正
- **diff 方向误判实例**：types.ts/pi-cron.sh 工作区 diff 显示 `- deleted 字段`（HEAD 有、工作区无）——即本机落后于已推送的 7f9a8f0，却被误判为"并行会话进行中工作"而保留在工作区。注释里的当日日期强化了误导。正确读法：`-` 行=HEAD 有工作区无→本机旧；`+` 行=工作区新增→本地新改动。**判断前先 `git log --all -- <file>` 查该文件的最近提交**，日期巧合不构成证据。
- 后续处置：三文件（types.ts/pi-cron.sh/docs/AGENTS-DETAILS.md）checkout HEAD 恢复，autopilot 131 用例复验绿；AGENTS-DETAILS 的 memory/stats 旧说法（不入库）与新同步约定矛盾，一并更正。

### 2026-08-26（续）全项目审计修复闭环 v2（2 HIGH + 17 MEDIUM + 14 LOW）
- **多实例并行开发是常态而非异常**：本审计进行中同机另一 pi 实例提交了 pi-context 暖前缀功能（14:07），导致 16:29 的 test-all 结果与早晨全绿不一致、cache-guard baseline 漂移。处置纪律：修复前先 `git log --oneline -3 -- <热点文件>` 确认归属；不碰对方文件；提交只 add 自己的改动清单，绝不 `git add -A`。
- **pi dist 补丁丢失的快速定位路径**：tsc 报「no exported member X」且 X 属补丁注入 API → 直接对 PI_DIST 重跑 patch-*.mjs（幂等）+ verify-patches.mjs 复核，无需整跑 rebuild.sh（40+ 分钟）；本次 4 分钟恢复。
- **测试继承宿主 env 的隐蔽污染**：pi 会话内跑 vitest，PI_SESSION_FILE 指向活会话文件 → watchdog isHanging 第二信号 mtime 恒新鲜、挂死判定永假——涉及时间/mtime/env 的测试用例必须显式隔离相关环境变量（save/restore in finally）。
- **被测函数吞异常时禁用 rejects 断言法**：tick() 有 `catch { /* suppress */ }` 时 mock process.exit 抛错断言 rejects 必然失败（错误到不了测试层）；改为 exit mock 成 no-op + 断言 exitSpy 调用参数等副作用。同理断言必须在 mockReset 之前（reset 清空调用记录）。
- **vi.mock 部分 mock 模式**：`vi.mock('./x.ts', async (importOriginal) => ({ ...await importOriginal(), targetFn: vi.fn() }))` 可只替换单函数保留其余实际导出——比整模块手写 mock 稳，适合"测集成点 A 调用了 B"而 B 真实逻辑已有独立测试的场景。
- **SAFE/DESTRUCTIVE 白名单修复选型**：写引用类命令（git branch -D/-M/-u/--force）修在 SAFE 白名单枚举只读参数集，而非 DESTRUCTIVE 枚举写 flag——白名单法天然防未来新 flag 绕过；DESTRUCTIVE 前缀匹配仅用于无只读子集的命令族（find -fprint0? 去 \b 改前缀是 fail-closed 可接受误拦）。
- **安全修复的易用性平衡**：browser upload 用敏感黑名单（.ssh/auth.json/*.pem…）而非全路径白名单——业务文件上传不可枚举，黑名单覆盖凭据面已消除主要风险；cookie 对 httpOnly value 脱敏而非全拒——保住调试用途同时切断会话窃取面。
- **设计取舍 vs 缺陷的定性要给依据**：failover 无确认 exit(0)、saveEntries 快照优先均定性为设计并注释理由（无人值守场景加确认永不生效 / tests 显式断言快照优先），而非盲改行为——复核子代理判"真实"不等于应改码，主会话终审要区分「真实缺陷」与「真实存在但属有意取舍」。
- **test-all 全绿≠当前仓库状态健康**：两次运行间并行线可改变一切；回归结论必须标注运行时间点，跨时段比较前先重跑。

### 2026-08-26 全量审计（运行态 + 40 条建议复核闭环）
- **已沉淀教训重复踩坑 → 必须升格进 SKILL 正文**：08-25 基线已记“tmux_run 禁管道 tail”，08-26 审计首跑仍用 `| tail -80` 致日志空白——基线是“翻阅型”知识，执行者不会主动检索；流程性铁律必须写进 SKILL.md 对应步骤（本次已升格至第 2 步）。
- **抽查脚本先验字段名**：检查 summaries.json 时臆测 summary/text 字段报出 5 条假“空摘要”（实际字段为 fullText/title/decisions 等），虚惊一场后重查——对 json 数据文件先 `list(items[0].keys())` 看结构再写断言。
- **diag 单轮 cacheRead=0 的快速定性法**：尾部出现 in≈ctx、cache=0 时看下一轮——次轮即恢复 96%+ 命中 = provider 侧偶发未命中（C 类），非注入面断裂（真断裂会连续低命中）；本次 37K 单次浪费不处理。
- **patch 类 dry-run 设计缺陷新模式**：patch-voice-enter.mjs 的 MARKER 短路在 dry-run 判断之前——对已打补丁系统 dry-run 只能验“跳过”验不了正则锚点；锚点正则验证需在未打补丁副本或临时还原件上做。
- **工具执行类 flag 审计应建统一清单**：rg --pre/fd -x/find -exec 已修但 sed e/s///e 漏网（同属“读白名单工具携带执行语义”）——审查此类白名单时逐工具核对 man 手册执行类 flag，而非逐个历史漏洞打补丁。
- **复核子代理产出质量高**：40 条初审 31 真实/7 部分属实/2 误报撤销；行号漂移最大约 70 行（组3 scripts 引用），文件路径错标 1 处（link/scripts→scripts）——复核不可省，且要求复核者显式指出实际位置有效。

### 2026-08-25（续二）0.84.3 升级后全量审计修复闭环（20 项落地）
- **上节 types.ts「注释虚标」谜团闭环**：deleted 墓碑注释（带当日日期）确系并行会话只落了注释/字段、未落实现——本会话补齐实现（listTasks 过滤 + importTasks 拒绝导入）并把注释改写为与实现一致。「注释与实现矛盾」时先 `git log --all -- <file>` 追溯来源再决定补实现还是改注释；**注释里的日期不构成已实现的证据**。
- **tmux_run 长任务禁用管道 tail**：`| tail -80` 吞掉全部中间输出，日志全程空白极易误判脚本失败（本次实战踩坑）。一律 `> /tmp/x.log 2>&1; echo EXIT=$? >>` 直接重定向，tail 仅事后查看。
- **审计报告行号普遍漂移**（本次最大偏 47 行；scripts 组行号却全精确）——复核必须按内容定位，行号仅作提示；行号精度可作为审查者质量信号。
- **红灯验证单文件回退法**：`git stash push -q -- <file>` 只回退目标文件 → 跑新测试确认失败 → `stash pop`。比整体 stash 干净，不碰并行改动。
- **worker 现场修正可优于审计方案**：Windows pidfile 记录的是 spawn 的 shell 进程 → taskkill 映像名白名单应为 node/bash/cmd.exe 而非字面 node.exe（字面版会让 Ctrl-C/taskkill 全失效）。采纳 worker 版并在报告注明理由；抽查 diff 时对"合理化偏离"逐个判断而非要求逐字执行。
- **探针先于盲修**：不确定真实触发面的缺陷（provider 缺流式 usage → 扩展层压缩/压力提示/thinking 切档全失效，#8328 同类假设），先加观测事件（usage-missing，10min 节流）积累数据，不盲目加兜底逻辑。
- **聚合测试入口清单完整性属注册面纪律**：test-all.sh ALL_EXTS 漏 subagent 致 subagent-guards.test.ts 在任何入口零执行——新增扩展/套件必须同步聚合清单（同 conflict-check 监听者清单约定）。
- **edit 工具 oldText/newText 方向纪律**：newText 是完整替换文本，长中文块编辑前先确认方向（本会话写反两次，原子回滚保证了误配不落盘）。
- **push 微流程**：活进程持续追加的统计文件在提交与推送间隙会再变脏 → pull --rebase 报 unstaged 时对该单文件 stash 即可；SSH remote 无 token 免 set-url 还原。

### 2026-08-26 文档一致性专项审查（21 处发现，方法论升格进 SKILL 第 1c 步）
- **数量口径多点漂移是最高频过时模式**：扩展数（10→11）、技能数（4→5）、patch 数（8→9 口径）在 README/AGENTS.md/DETAILS/BASELINE/脚本注释五处重复——新增 pi-intervention 时只更新了 conflict-check/test-all，全部文档计数漏改。发现一处失真后 grep 全仓库同口径数字逐处清点。
- **失效跨文档引用新模式**：环境变量删除后引用方不跟着删（PI_CONTEXT_RESTART_RATIO 已从 pi-context 移除，autopilot README+tools.ts 注释仍引用）——删公共 API 时 grep 引用面应含所有 .md 与注释。
- **状态标记矛盾模式**：ROADMAP `[x]` 打勾却注「待实现」，且 §2 差距摘要与 §6 状态表互相矛盾、实际代码已落地（lesson-miner 自述阶段号可作证据）——勾选框语义必须与文字一致，「规划确认」和「已完成」不能共用 [x]。
- **文档审查分组法**：按对象分四组并行 scout（根+docs / AGENTS 注入主文档 / 扩展README↔源码 / 工具类文档），比按目录遍历快且覆盖全；每组只报可证伪项（文档原文+实际证据），没问题一句话带过。
- **文档类发现豁免子代理复核**：核实只需一条 grep/test，主会话直接定论；子代理复核留给代码行为类建议。
- **TOKEN-BUDGET 类 API 文档失真最重**：函数已删/签名变更/阈值改档位后使用文档三处以上不同步——共享库导出变更时其 .md 文档必须列入同步清单。

### 2026-08-28 全项目审计（tmux 测试截断补验 + 复核截断省 token 处置）
- **tmux_run 全量测试无 EXIT= 标记 = 会话被提前终止**：test-all.sh 在 subagent mjs 测试段会话终止（vitest/tsc 全绿落盘后 EXIT 未写入），单独补跑该段 65/65 通过——命令串中段被杀属 tmux 自动退出包装与测试子进程交互的偶发，重定向日志完整≠执行完整，**判读全量测试结果必须先 grep EXIT= 确认收尾标记**；缺失时按脚本阶段清单逐段补跑（各阶段独立、重入安全）。
- **复核报告尾部截断时按条目核实成本分流**：截断残留若是「一条 grep 可核实」的 LOW/事实类条目（脚本计数/硬编码/env 读取），主会话单条 bash 补验比重委派 scout 省 10 倍 token；机制复杂条目才重派。
- **审查报告「无限循环」类描述需复核熔断路径**：fireViaMessage 失败→failover 循环描述被复核证伪为「1 次重启即熔断 suspend」——恐惧性传播链描述（失败→重启→再失败）必须核对熔断计数器才能定级。
