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
