# 优化实验日志（OPTIMIZATION-LOG）

> 规则：**每次对 pi 行为/扩展/配置/脚本的优化改动，无论大小，必须在此追加一条记录**。
> 三段式：**Before / Change / After**。缺 Any 一段的记录视为无效，后续会话不得据此做归因决策。

## 记录模板

```markdown
## YYYY-MM-DD <标题>
- 状态: done | rolled-back | pending-verify
- 关联: (roadmap 阶段项 / 触发问题)

### Before
- 现象/指标（实测数字，含时间与测量命令）：

### Change
- 改动文件与内容（diff 要点，勿贴整段）：
- 决策依据：

### After
- 复测结果（同口径 Before 数字）：
- 回归: test-all 绿/红
- 结论：保留/微调/回滚
```

---

## 2026-08-20 存储告警线放宽（900KB/1MB → 1.8MB/2MB）
- 状态: done
- 关联: roadmap §5 低风险参数微调；用户确认"是否提高上限"→ 实证后结论：不设硬限、仅放宽告警口径

### Before
- memory_store 写入后 totalSize>900KB 即报"接近 1 MB 上限"；/memory status 显示"/ 1 MB"。实证存储库**无硬性拒绝写入**（storage.ts:57"替换为占位符而非拒绝写入"），1MB 仅为告警/展示口径。
- 当前占用 0.25MB，距 900KB 约 2.6 倍余量；注入只取 top-4（≤500 token），存储量不影响注入与缓存；真正的压力点是不限条数（已由 600 软删回收线控制）。

### Change
- tools.ts: 告警线 `900*1024`→`1800*1024`、文本"接近 2 MB 上限"；memory_stats 显示"/ 2 MB"；notes MAX_NOTES_SIZE 1024*1024→2048*1024（notes 当前仅 3KB，口径对齐）；
- commands.ts: /memory status "/ 1 MB"→"/ 2 MB"。

### After
- 残留检查：无旧口径残留（grep "900 \* 1024|MB / 1 MB|接近 1 MB|exceeds 1 MB" 为空）。
- 回归：pi-memory vitest 99 全绿；test-all.sh --fast 9 扩展 + tsc 全绿（后台 06:1x）。
- 结论：保留。字节硬限本就存在无需新增；告警阈值提到合理水平，避免无意义干扰。

## 2026-08-20 知识订阅自动化（roadmap 3.2）
- 状态: done（实弹验收待次日 08:30）

### Before
- 无主动知识获取：搜索只在用户提出时被动发生；用户提供 5 关键词（人工智能/系统漏洞/网络病毒/科技新闻/重要新闻）。

### Change
- 新增 scripts/knowledge-fetch.py（**零 LLM**）：本地 SearXNG JSON 抓取，标题 hash 去重（logs/knowledge/.seen.txt）、低价值标题过滤（百科/教程/名词解释/教育类）、按日落盘 logs/knowledge/<date>.md。
- 并入 daily-health-check（步骤 4）：读当日新增 → 挑 3-5 条高价值（时效强/漏洞/病毒/重大新闻，剔过时教程/门户首页/多源冗余）→ 逐条 memory_store fact（标题 "knowledge <子主题> <日期>"，含要点+URL）→ 入库前 memory_search 判重；知识失败不阻断健康判定。

### After
- 首次真实抓取 35 条基线（过滤生效）；SearXNG 结果动态波动使每日有少量增量（符合预期）；残留噪音由入库层在时效/重复上收尾。
- 验收：次日 08:30 检查 logs/knowledge/ 与 knowledge-* 记忆条目。

# 更正（2026-08-20）：P1 归因错误已回滚

用户质疑“1M 上下文为何被硬裁”后重新取证，P1 结论被证伪：
- 会话 jsonl 无任何真实 session_compact/compaction 事件（63 处 compact 匹配全是源码文本与论述）。
- “断链轮”分两类：① 缓存 TTL 过期（间隔 5–26 分钟 MISS，cacheRead 原值恢复，上下文未变）；② 跨会话边界（usage-stats 相邻段是不同独立会话各自增长，非同一会话内压缩）。当前会话 cacheRead 0→152K→90K+ 一路健康增长，1M 窗口从未触顶。
- 网关“130-155K 硬裁”系误诊（被断链点与窗口的数值巧合误导）。
- 已回滚 extensions/pi-context/index.ts fallback 窗口回 1M（注释保留更正说明）。
- 教训：勿把 usage-stats 会话分段的 ctx 起止误读为同会话内压缩史；判断压缩/裁剪必须以会话内 compaction 事件为准。

## 2026-08-20 P1：opencode-go fallback 窗口 1M→160K（缓存断链根因，roadmap §4）
- 状态: done（待重启 pi 进程后加载生效）

### Before
- 根因链：opencode-go 是内核不完整识别的自定义 provider（getContextUsage() undefined）→ pi-context fallback 默认窗口 1M（PI_CONTEXT_WINDOW_FALLBACK）→ auto-compact 80% 阈值=800K。实测网关约在上下文 130–155K 强制裁剪（cacheRead 自 -130K 骤降 -1K），pi 永远等不到 800K → 每次长会话多次断链、46–130K 全量重发（本会话 4 次断链、浪费 ~40 万 tokens；10:19 单轮 130K 重发）。

### Change
- extensions/pi-context/index.ts：FALLBACK_CONTEXT_WINDOW 1,000,000 → 160,000（80% → 128K 主动压缩，抢在网关 ~154K 硬线前）。内置 provider（有真实窗口）不受影响；env 覆盖仍优先。

### After
- pi-context vitest ✓ + tsc ✓（无断言旧默认值的测试）。
- 生效条件：重启 pi 进程/新会话加载新代码。观察 2-3 天：预期压缩点提前到 ~128K 主动触发、cacheRead 归零大减、浪费降 90%+。
- 遗留：若观察发现 I60K 仍偏保守/过激进，可经 PI_CONTEXT_WINDOW_FALLBACK 或再调默认值微调。

## 2026-08-20 文档解析依赖安装（3.1 补齐：poppler-utils + tesseract chi_sim）
- 状态: done

### Before
- PRoot Ubuntu 24.04 无任何文档解析工具；doc-extract.py 的 PDF/OCR 分支空置。

### Change
- 用户确认后 apt 安装：poppler-utils 24.02.0、tesseract-ocr 5.3.4、tesseract-ocr-chi-sim（含 eng/osd）；走系统自带腾讯云镜像（~13MB），--no-install-recommends。

### After
- pdftotext 24.02.0 ✓ tesseract 语言 chi_sim/eng/osd ✓；doc-extract.py PDF 分支实测：构造最小 PDF 提取 "Hello PDF test 123" 与 pdftotext 对照一致。
- OCR 分支：tesseract 与 chi_sim 就绪，待真实图片时偶验。
- 回归：脚本独立、未碰扩展 TS。

## 2026-08-20 文档提取器 doc-extract.py（roadmap 3.1 零依赖部分）
- 状态: done（PDF/OCR 依赖待确认安装）

### Before
- 无任何文档解析工具；docx/xlsx/pdf/OCR 全部缺失，本地资料无法进上下文。

### Change
- 新增 scripts/doc-extract.py（纯 python 标准库）：txt/md/csv/json 直接读；docx（zipfile 解包 + XML 提 `w:t`，段落/cell/行替换换行与 tab、HTML 反转义）；xlsx（sharedStrings + 工作表 `<c>` 单元格提取，tab 分隔）；pdf 调 pdftotext（检测存在才启用）；图片调 tesseract chi_sim+eng（检测存在才启用）；--limit 截断；默认 400 行。

### After
- 验证：txt ✓；docx 标题/段落/表格/`&` 转义 ✓；xlsx 双列表格 ✓；--limit 截断 ✓；未知类型拒绝 exit 2 ✓。
- 已知限制：docx 表格逐格换行输出（信息不丢、缺行内对齐）；PDF/OCR 需装依赖，装后自动激活。
- 待办：确认 apt 安装 poppler-utils / tesseract-ocr + tesseract-ocr-chi-sim。

## 2026-08-20 通知推送层（roadmap 阶段 3.3，骨架完成）
- 状态: done（待用户填渠道启用）

### Before
- 无人值守可感知缺口：autopilot 的 sendWebhook 无 URL 配置即失效；自检 health-alert 只写 memory/log，无法主动触达。

### Change
- 新增 scripts/pi-notify.sh（node）：模板命令通道（{{subject}}/{{body}} URL 编码 + {{*_json}} 转义）、rateLimitMinutes 去重（**先标记再发，失败也计入**防重试轰炸）、dry-run 不写状态、失败静默 exit 0、logs/notify.log 留痕。
- agent/notify.example.json 模板（Bark/Server酱示例）；notify.json/.notify-state.json 入 .gitignore（可能含 token）。
- scheduled-tasks.json 自检任务 prompt alert 分支联动 pi-notify（失败可忽略）。

### After
- 验证：未配置/disabled 静默 ✓；dry-run 渲染正确（URL 编码/JSON 转义）✓；去重生效（第一次失败后同 subject 第二次 rate-limited）✓；dry-run 不污染状态 ✓。
- 回归：改动面为独立脚本+JSON 配置，未碰扩展 TS，不触发既有测试面。
- 待办：用户提供渠道（Bark/Server酱 key）填 notify.json 置 enabled=true 后首测。

## 2026-08-20 每日自检任务（roadmap 阶段 2.1，autopilot cron）
- 状态: done（实弹验收待次日 08:30）

### Before
- 自优化闭环缺自动触发：命中率/记忆库监控靠手动跑 usage-stats·memory_stats；scheduled-tasks.json 任务为空。

### Change
- 用 storage.addTask 创建 cron 任务 daily-health-check（表达式 30 8 * * * 每天 08:30）：prompt 为只读自检（cd /root/.pi → usage-stats 取命中/断裂 → memory_stats → 命中<90% 或断裂>3 或存储>0.8MB 时 memory_store 存 health-alert；正常仅追加一行 ~/.pi/logs/daily-health.log）；maxRunTime 300s、tags [self-optimize,health]、retries 2。
- 离线触发由已有 pi-cron.sh（系统 crontab 每分钟）承接。

### After
- 落盘确认：tasks=1、nextRun=2026-08-20T00:30Z（北京时间 08:30）；dry-run 验证命令链（usage-stats 输出含判据行、日志行写入正常）。
- 验收项：次日 08:30 首次实弹触发，检查 daily-health.log 与 health-alert 是否按预期落地。

## 2026-08-20 澄清缓存断裂归因（记忆注入非主因）
- 状态: done
- 关联: roadmap 阶段 1.2；SELF-OPTIMIZING-ROADMAP/基线报告

### Before
- usage-stats.mjs A 类断裂诊断文本断言"注入块在头部，变化整段重放"；但 8-19 三次断裂浪费 500K 远超注入块 ≤500 token，归因方向可疑，会误导后续自优化决策。

### Change
- 实证：pi 源码 agent-session.js:902（before_agent_start 返回 custom 消息 push 到消息数组末尾，user 之后）+ 会话文件查验（注入消息紧随 user 消息）+ buildInjectionBlock 无写入时两次构建完全一致（确定性）。
- 更新 usage-stats.mjs 4 处诊断文本为"注入块在尾部、非大浪费来源；优先查 compaction/早期消息改写/大工具输出/provider 缓存键"。

### After
- 脚本 node --check 语法 OK，输出正常（当前会话 91.7%，A 类 1 次）。
- 回归：test-all.sh --fast 全绿。
- 结论：保留。后续会话不再将大断裂误归因记忆操作。


## 2026-08-20 pi-full-audit 全面体检 + 修复批1（第4步复核后）
- 状态: done（全量回归待最终确认）

### Before
- 确定性检查 2 失败：auth.json 密钥=预期本地凭证（gitignore）；pi-notify.sh shell 语法=node shebang 被当 shell 误报。
- 4 组 scout 并行审查产出建议；复核子代理逐条核实修正（context 钩子=链式传递非 last-wins、cron 锁有存活校验、resetBudget 3 处调用等）。

### Change（复核后修复批1）
- scripts/knowledge-fetch.py:78 getsize 崩溃→exists 判断；docstring --days 对齐 --limit
- pi-memory SECRET_PATTERNS 补 PEM 私钥 + 密码/令牌键值形态（排除集含 \x5b 防二次匹配已替换标记）；markExtracted→writeJSONAtomic
- pi-link state-writer/active 直写→tmp+rename 原子写；buildRemoteCommand session-dir JSON.stringify 引号保护（测试断言同步）
- pi-autopilot policy 鉴权分支前移（先于 logic_error）
- pi-voice WakeSession.stop SIGKILL 死代码修复（局部快照闭包）
- pi-tmux Windows send-keys stdin EPIPE 捕获
- plan-mode NORMAL_MODE_TOOLS 补 memory_search/memory_recall/ctx_note（执行模式记忆可检索）
- README/impl 不存在 install.sh→web-search 用 start-searxng.sh、browser 用 npm install
- cache-guard baseline 固化（pi-context 注释改动审计通过）

### After
- 受影响 7 扩展 vitest 全绿 + tsc ✓（pi-memory 1 用例回归先红后修）；pi-link 2 断言随行为同步。
- 遗留：注入预算放宽（设计权衡保缓存稳定，降 LOW）；调度语义（appendRun/failover graceful/双调度锁）立项批2 待有完整测试环境执行。

---

## 2026-08-20 长会话 A 类断裂归因诊断（93.4% 命中率分析）
- 状态: 诊断（非改动）；关联: SELF-OPTIMIZING-ROADMAP §4.1 命中率退化

### 现象（Before）
- 当前会话（230+ 轮 / ctx 176K / max thinking）命中率 92.5-93.4%，8 次断裂浪费 1.59M；
  A 类断裂 ×5 距上轮仅 11-30s（短间隔全断）。

### 排除项（逐步证伪）
- TTL 长停顿：A 类断点间隔 11-30s，非停顿首轮 → 排除
- auto-compact：logs/compact-snapshots/ 为空（今日 2.6 上线，ctx 176K 远未到 1M 窗口 85% 阈值）→ 排除
- 工具结果分层擦除（pruneToolResults）：usage-diag prune 事件本会话为 0 → 排除
- 工具启用/注入块：本会话未 enable 休眠组；注入块尾部 ≤500 token → 排除

### 根因（判定）
- **A 类断裂 = pruneThinkingBudget（64K 预算）静默改写早期 thinking 消息**：
  max thinking 每轮 5-10K reasoning，长会话累积远超 64K → 触发时删除较早期 thinking →
  早期消息被修改 → 前缀整体失效 → 下轮 A 类重发。
- **盲点确认**：recordPrune 只在 pruneToolResults 路径调用（index.ts:391）；pruneThinkingBudget
  （index.ts:417-421）无任何事件记账 → 触发不可见。是当前唯一无账可查的 post-hoc 改写。

### 结论与建议（After / 后续工单）
- 行为符合设计权衡（BASELINE 16K→39 断 / 64K→4 断已实证），非 bug；命中率仍 >90% 健康线。
- 可改进（低优先）：给 pruneThinkingBudget 加事件记账（同 recordPrune/快照），使 A 类断裂可归因——待工单。
- 对照实验（若频繁 100K+ 长会话）：thinking 档位 max→high，before/after 记入本 LOG 再定。

---

## 2026-08-20 thinking 档位 max→high 切换（task #14 对照实验起点）
- 状态: 变更（用户主动配置，settings.json 本地不入库；无代码改动）

### 变更（Change）
- agent/settings.json defaultThinkingLevel: max → high
- 触发背景: 昨日诊断确认长会话 A 类断裂 = thinking 剪枝（pruneThinkingBudget
  静默改写早期 thinking）；high 档减每轮 reasoning 量、降 64K 预算触达频率。

### Before（max 档基线，已完成）
- 当前会话: 93.4% / 8 断（A×5 + B×2 + C×1）/ 浪费 1.59M；A 类归因=thinking 剪枝
- 2026-08-18 16K 预算实测: 触发率 70%，3.8h 27 断 / 1.46M 浪费

### After（high 档待观测）
- 注入面判定: thinking 档位不入 system prompt → 切换不额外断缓存、不污染前缀
- 预期: 每轮 thinking 下降 → 剪枝触发间隔拉长 → A 类断裂减少 → 命中率回升
- 观测: 每日 daily-health-check 命中率 vs Before；本 LOG 后续追加对比行

---

## 2026-08-20 HIGH 修复：pi-link 远程命令注入（buildRemoteCommand）
- 状态: 修复完成（pi-full-audit 组1 scout 发现 + 主会话终审确认 + 回归）

### 漏洞（Before）
- link.ts buildRemoteCommand：sessionDir/cwd 经 JSON.stringify 后拼入**双引号** shell
  上下文（`--session-dir "..."` / `cd "${cwd}"` / `ls -t "${sdir}"/*.jsonl`）。
  JSON.stringify 不转义 `$()`/反引号/分号 → 配置含元字符即在远端双引号内被命令替换
  执行（任意命令注入）。

### 修复（Change）
- 新增 shellSingleQuote(s)：shell 单引号包裹（转义 `'`→`'\''`），单引号内无展开/命令替换。
- sdir → `SDIR='...'` 存变量 + `"$SDIR"` 引用；--session-dir 参数用单引号包裹。
- cwd → `CDIR=$HOME'/...'`（~ 展开拼 $HOME 前缀）或 `CDIR='...'`，`cd "$CDIR"`。
- 原理：单引号不做命令替换 + 变量展开不二次解析，阻断 `$()`/反引号类注入。

### 验证（After）
- 新增注入拒绝测试（sessionDir `$(touch ...)`、cwd 反引号+分号 → 均单引号字面）。
- pi-link vitest 59 通过（构造变了，更新既有 4 断言）；tsc 通过；全量回归待跑。

---

## 2026-08-20 MEDIUM 修复批（审计续，pi-link/pi-autopilot/pi-memory）
- 状态: 修复完成

### #22 pi-link 会话连续性 ~ 未展开（组1 MEDIUM）
- 问题: resumeProbe 用 SDIR 变量，默认 sdir 以 ~ 开头，双引号变量内不展开 $HOME →
  ls 查字面 ~ 目录，会话连续性恒 false。
- 修复: sdirAssign 对 ~ 开头拼 $HOME 前缀（与 cwd 一致），resumeProbe 用展开值；
  --session-dir 仍原样传 pi（pi 端自解析）。

### #23 pi-autopilot /auto restart 无兜底退出（组1 MEDIUM）
- 问题: commands.ts restart 仅 try ctx.shutdown catch exit，TUI 环境不退出进程。
- 修复: 对齐 tools.ts，加 setTimeout(()=>process.exit(0),1500) 兜底。

### #24 pi-memory 矛盾检测仅 top-1（组3 MEDIUM）
- 问题: decideMerge 矛盾检测只对 findSimilar top 1，矛盾条目排第二时漏检、
  两对立记忆并存。
- 修复: 遍历 top-N 相似条目（similar），任一矛盾即取代（保留 manual 低置信保护）。
- 测试策略: top-N 依赖 BM25 排序难稳定构造"矛盾条目非首"用例，不新增脆测试；
  现有 3 个 contradiction 测试（104 全过）保障取代核心逻辑不回归。

---

## 2026-08-20 全面检查（pi-full-audit）整体总结
- 范围: /root/.pi 全仓库（352 源文件）；确定性检查 + 全量基线 + 4 组审查 + 修复批回归
- 修复落地: HIGH 3 项（pi-link 注入 / usage-stats 崩溃 / autoReclaim）+ MEDIUM 6 项
  （recordToolUsage / usage-summary 口径 / pi-whisper+knowledge-fetch 插值 / pi-link ~ 展开
  / autopilot restart 兜底 / 矛盾 top-N）；提交 0e0d393 + db8ee3e，回归全绿
- 遗留（设计权衡/外部）: policy failover 死值、plan-mode 覆盖序、锁滞留、hook 组合序、
  telemetry 跨进程、opencode-go 间歇限流（外部）
- 关键教训（详见"排查需先实测决定性证据"记忆）:
  ①归因前先实测，勿凭单条错误/先验断言（opencode-go 间歇限流误判为稳定）；
  ②scout 间歇失败≠永久不可用，重试+主会话兜底保覆盖；
  ③误报判别先行（pi-notify Node 脚本 .sh 命名、auth.json gitignored=预期）；
  ④修复前读实际代码确认 anchor，避免 edit 失配回滚。

---

## 2026-08-26 进化基建强化（VISION P1-P4 落地）
- 动机: 用户口述终极愿景（docs/VISION.md v1）；度量/干预/防退化三面缺口
- 落地:
  - P1 pi-intervention 扩展：input(steer)/before_agent_start/tool_execution_start/agent_end
    四事件捕获 abort 快照 + 15min corrective prompt 关联 → memory/interventions.jsonl（git 忽略）
    （queue_update 不在扩展 API 面，改用 input.streamingBehavior==="steer"）
  - P2 scripts/task-metrics.mjs：会话级成功代理/干预/token 聚合（只读）。
    首个基线: 21.9 天 / 537 会话 / 成功代理 47.1% / 均 1749K tok
  - P3 scripts/golden-tasks.sh：--fast 确定性四检查（全绿）/ --full 无头 pi 两任务（未实弹，费用边界）
    （bash 工具管道 64KB 截断坑 → JSON 校验走临时文件）
  - P4 scripts/memory-lifecycle.mjs：淘汰/升格/冲突三类只读报告。
    首报发现垃圾条目 "test"(rec=62) 污染检索，待用户裁决删除
- 守门修复: cache-guard 基线欠账（78571df 改 pi-context/index.ts 未重置基线）+ 本轮 AGENTS.md
  愿景指针 → --update-baseline；pi-browser 清扫测试 50ms 固定等待 → 轮询 3s（负载抖动）
- 回归: test-all.sh 全绿（9 vitest 套件 + tsc + 63 subagent + 注册面 29 + conflict-check +
  cache-guard + doc-lint + 发现完整性 11 扩展）

---

## 2026-08-29 自优化闭环断点修复（空壳投喂 + daily-health 停更 + 停摆根因更正）
- 动机: 方向分析发现闭环三断点——①蒸馏投喂 4+ 次空壳（烧真金 token 零产出）；
  ②daily-health.log 08-24 起停更，VISION 判据"命中率≥97%"失去每日度量；
  ③summaries.json 08-26~08-28 断档根因记忆有误判（"模型不支持"以偏概全）
- 落地:
  - 源端确认已修: pi-memory extract --no-extensions（d185267）+ PI_DISABLE_TASK_RECORD 守卫
  - 消费端防线: scripts/task-summarizer.mjs 聚类前 isDistillable 过滤（空 request /
    tools=0且output=0 / 内部子进程 prompt 兜底），空壳轮不再计入轮数与投喂清单
  - 存量清理: logs/task-records.jsonl 1288→148 条（全零 1048 + 提取器 prompt + 封顶伪影 73），
    备份 .bak-20260829；--dry-run --since 验证过滤生效
  - 伪影归因更正: hit=250000 = provider 对 1M 窗口封顶报 cacheRead（73 条实测全为
    空 request/cctx=850K/零产出中断轮），非本地统计 bug
  - daily-health 硬层恢复: 新增 scripts/daily-health.mjs（口径对齐 usage-stats，零 LLM，
    alert 判据=会话≥3 且命中<90% 或 AB 断裂>3），接入 autopilot daily-task 步骤2；
    首跑即报 alert（24h 命中 93.0%、AB 断裂 26、浪费 1858K）——度量恢复即生效
  - 停摆根因更正入 memory: 双层根因（ox-alpha-free 下架 ModelError + 扩展定时器挂 -p 超时），
    均已 08-28 闭环；合并记忆条目取代旧跟踪条目
- 回归: node --check × 2 + golden-tasks --fast 全绿 + test-all --fast（见下）

---

## 2026-08-29 续：防退化安全网补全（升格候选过滤 + golden --full 实弹）
- 动机: 方向 2 遗留两项——①memory-lifecycle 升格候选把噪声条目 "test"(rec=34,
  content='content') 当高复现有效条目，违反 VISION §3.3 防退化第一（错误教训会自我强化）；
  ②golden-tasks --full 无头两任务从未实弹，行为级退化无真实检测
- 落地:
  - memory-lifecycle.mjs 新增垃圾嫌疑规则（content 归一化 <30 字符或标题为测试噪声词），
    垃圾嫌疑不进升格候选；报告新增 [垃圾嫌疑] 段（人读 + --json counts.junkSuspects）。
    全库校验：content<30 仅 "test" 一条，零误报；升格候选 3→2 条
  - golden-tasks.sh --full 档 export PI_DISABLE_TASK_RECORD=1（G1/G2 断言轮不进
    task-records，防蒸馏队列把测试指令当任务）
  - 实弹结果: G1 文本响应断言 ✓ / G2 工具写入断言 ✓，fast 四检全绿——P3 行为级
    安全网首次真实通过（费用：两次短无头会话）
- 待裁决（用户确认级）: 垃圾嫌疑 "test"(id 762000d2) 删除；升格候选 2 条
  （翻译脚本匹配技巧/代码标识符不应翻译，rec=25）进入 §3.1 通道评估
- 回归: test-all --fast exit=0（12 ✓）

---

## 2026-08-29 续 2：长期记忆全量检查 + daily-health 跨设备接入（种子机制）
- 记忆检查（快照 logs/entries.json.bak-20260829-preopt）:
  - 647 活跃 / 0.71MB；标题归一化重复 0 组、content 完全重复 0、>90 天未访问 0、
    >180 天 0、淘汰候选 0——结构健康（三方合并+去重机制运转正常），"膨胀"是量
    （647>600 触发线）非腐坏；注入预算贴顶（496/500）的根解是 L0 分层注入（4.5）
  - 优化执行: 删除垃圾条目 "test"（id 762000d2，content='content'，上一轮已列裁决项）
    → 646 条，垃圾嫌疑清零；升格候选 2 条维持待裁决
  - 发现但不动: environments 格式疑似不一致——【2026-08-29 勘误】复查证实为统计
    脚本假象（or 'all' 把缺失字段显示成字符串）：11 条实为合法缺字段（isEnvVisible
    显式语义=通用），现行 memory_store 写入路径本就干净（单值自动转数组）；唯一残余
    1 条 ['wsl2','all'] 顺序颠倒仅影响列表显示，不值得冒写回竞态。无需治理
- daily-health 跨设备接入（回答"入库同步 vs 提醒"）:
  - 脚本已入库=全设备共享；数据/日志本机隔离是正确设计不入库
  - scheduled-tasks.json 不入库且种子对账"已存在跳过"——改 daily-task 种子传不到
    老设备；正确通道=新增独立种子任务
  - 落地: agent/scheduled-seeds.json 新增 daily-health（cron 7:50，字段对齐
    knowledge-subscribe；alert→daily-results 入库供 daily-review 跨设备对比，ok 静默）；
    实证 30s 内本机自动注册；同步回退本机 daily-task 里的手动接入句（避免同机双跑）
- 回归: memory-lifecycle 报告正常、seeds/scheduled-tasks JSON 合法

---

## 2026-08-29 续 3：L0 分层注入落地 + 升格通道首次闭环（用户批准）
- L0 分层注入（ROADMAP 4.5 ⏸→✅，触发条件满足：注入 496/500 贴顶）:
  - inject.ts: 条目 L0 摘要档 ENTRY_SUMMARY_TOKEN_CAP=36（≈72 汉字）、条数上限 4→8；
    摘要 L2 结构化段保持 80（决策/事实要点密度高）；确定性提取零写入侧改动零迁移
  - 同 500 token 预算主题覆盖翻倍；全文走 memory_search 不变
  - 测试: inject.test.ts 新增 L0 断言 + "caps entries" 对齐 8；130/130 过；
    cache-guard 注入面基线更新（--update-baseline，HIGH 漂移=预期注入格式变化）
  - 抖动记录: pi-link vitest 在 test-all 中间歇红（单独跑稳定 102 过，两轮 test-all
    红→绿）——历史同款环境抖动，不阻塞
- 升格通道首次闭环（VISION §3.1，用户 2026-08-29 批准）:
  - 「翻译脚本匹配技巧」「代码标识符不应翻译」（rec=25×2）知识点吸收进
    pi-translate-zh/SKILL.md「查找原则」节（子串/精确匹配、标识符不翻译、
    覆盖率口径偏差、stderr 归属核对），节尾标注升格记录
  - 原两条记忆删除（硬承载完成，原软引导降权）→ 644 条
  - 评估说明: 两条内容与 patch-all-zh.mjs 脚本互为表里，SKILL.md 是规则文档承载位；
    记忆的增量知识（匹配方式/口径偏差/归属核对）此前未文档化，吸收有实质增量
- 回归: test-all --fast exit=0

---

## 2026-08-29 续 4：自优化闭环缺漏批量修复（H1-H5，全面审计后用户批准"全部修复"）
- 审计来源：深度审计结论=六环齐备但为"LLM 会话中介的半自动闭环"，验证环≈50% 最大缺口
- H1 防退化基准自动化 + F5:
  - scheduled-seeds.json 新增 golden-fast 种子任务（cron 7:30，确定性零 LLM；红项才落盘
    daily-results+commit push，全绿静默——对齐 daily-health alert 模式）
  - golden-tasks.sh 新增 F5 干预快照写路径校验：写合成记录(type=golden-synthetic)→读回→
    按精确 id 清理→行数复原；验证捕获面文件层可用（hook 级触发验证留 --full）
- H2 记忆生命周期挖掘端接入: daily-review prompt 新增步骤 3（memory-lifecycle --json 只读
  报告）：升格候选按 §3.1 评估写入 LOG 待确认、冲突嫌疑给合并建议、淘汰候选仅列不动
- H3 覆盖面验证通道: 由 F5 承载（见 H1）；干预率判据计算仍需数据积累
- H4 蒸馏产物降置信: task-summarizer prompt 指示 memory_store confidence 一律 0.6
  （蒸馏非直接观察，防错误经验高置信自我强化；验证有效后可升置信）
- H5 跨设备/种子健康度量: daily-health.mjs 新增两项确定性度量并入 alert 判据——
  设备失联>48h（memory/stats/tool-use-*.jsonl 尾行 ts）、种子失配（seeds 声明未注册/
  schedule 漂移）；输出行加 设备=N(失联M) 种子失配=K；dry-run 实证：MYPC 失联 2 天正确捕获
- M 错峰: knowledge-subscribe 0 8→20 8（与本地遗留 daily-task 08:00 错开）；
  本机 scheduled-tasks.json 已同步 schedule 并注册 golden-fast（注入式，对齐本机
  daily-health 实践）
- 已知影响（非缺陷，为预期修复触发器）: seeds 对账"已存在不覆盖"——其他设备 pull 后
  knowledge-subscribe 仍为 08:00，将触发 schedule 漂移告警，届时由回顾任务/人工同步；
  MYPC 失联告警将持续直至设备恢复上线
- 回归: golden-tasks --fast 全绿（F1-F5）、test-all --fast 全绿（11 扩展+tsc）、
  daily-health --print 新字段输出正常、seeds/scheduled-tasks JSON 合法

---

## 2026-08-29 续 5：业界借鉴落地（低垂果实 3 项 + 中期/远期设计分析）
- 调研源：GitHub API 实测 26 仓 + jsdelivr 拉 README 原文（AHE/memU/MemOS/Evolver/GenericAgent 等）；
  关键参照 AHE（可观测性驱动 harness 进化）、memU（自动技能提取六步）、DGM（评价器博弈教训）、GEP 论文
- 5.1 访问强化（MemoryBank）: pi-memory storage.ts 新增 touchAccessedAt（命中回写 accessedAt，
  进程级 Set 去抖，fail-open，saveEntries 写前合并防墓碑复活）；tools.ts memory_search/memory_recall
  双挂点；新增单测（回写持久化/deleted 跳过/去抖）→ pi-memory vitest 全绿 + tsc 绿
- 5.2 干预→反思闭环（Reflexion）: daily-review prompt 新增步骤 3——解析 interventions.jsonl 近 7 天
  corrective 非空记录，有则提炼教训（solutions/confidence 0.6/前缀'干预教训:'/回链 ts）；seeds 与本机
  scheduled-tasks 双写（对账不覆盖已存在任务，必须本地同步）
- 5.3 守门防篡改（DGM 教训）: daily-health 新判据——test-all/golden-tasks/daily-health/verify-patches
  4 脚本 git status 未提交改动 → alert；dry-run 实证捕获本次自身未提交改动（闭环自证），提交后消除
- 中期 5.4-5.7 设计分析与远期 5.8-5.9 触发条件写入 ROADMAP 阶段 5（patch-vs-create/归纳升级/
  importance 阈值反思/自动课程；元优化等 corrective≥50 条；GEP schema 冻结+links 候选绑 5.5）
- 回归: pi-memory vitest+tsc 绿、daily-health --print 新判据正常、seeds/scheduled-tasks JSON 合法

---

## 2026-08-29 续 6：中期优化 5.4-5.7 全量落地（ROADMAP 阶段 5 中期项清零）
- 5.5 ExpeL 归纳升级（唯一代码级）: memory-lifecycle.mjs 新增第 5 类"聚合候选"——
  solutions/procedure 标题 bigram-jaccard 贪心聚类（阈值 0.34），组内 ≥3 条且 Σrec≥8 触发；
  人读+--json 双输出；合成数据实测：3 条同主题聚中/无关条目排除，Σrec 门槛生效。
  设计修正：执行侧不新增 UPGRADE 写操作，走既有"报告→确认→快照→执行"（对齐 VISION §5）
- 5.4 patch-vs-create（memU 第 3 步）: task-summarizer prompt 第 3 条改写——先查既有草稿，
  同主题→概述中列"建议 patch <文件名>：<差异要点>"待确认，无才新建
- 5.6 importance 触发反思（Generative Agents）: daily-review 步骤 2 内嵌确定性计算
  Σ(confidence×recurrence)>12 → 跨条目归纳 insight（带引用）。判定在确定性层（可测），
  反思在 LLM 层（软硬结合）
- 5.7 自动课程（Voyager）: daily-review 步骤 4——logs/lesson-course.json 状态比对，
  同主题连续第 2 天→workticket-<短名>.md 工单草稿（仅草稿不执行），状态文件每轮更新
- daily-review 整合为 6 步版（seeds+本机双写），maxRunTime 600→900
- 教训记录: edit 工具多 edit 原子回滚——edits[1] 未命中时 edits[0] 也不应用，
  但返回信息易误读为部分成功；多处不相关改动应分次调用或改用 node 直写
- 回归: golden --fast 全绿（F1-F5）、pi-memory vitest+tsc 绿、lifecycle 人读/json/合成数据
  三路验证、task-summarizer/lifecycle node --check 通过、seeds/scheduled-tasks JSON 合法

---

## 2026-08-29 续 7：远期优化启动（5.9a links 落地 + 5.8 分层设计）
- 5.9a links 双向链接（A-MEM 卡片盒，预案内唯一 schema 增列 v6）:
  - types.ts links?: string[]；storage.ts linkEntries（幂等/自环保护/纯内存）+
    autoLinkNewEntry（入库时标题 bigram-jaccard≥0.34 单链最优邻居，与 5.5 聚合同口径，
    links 连通分量即聚合候选图基础；自包含实现避免 storage↔retrieval 循环依赖）
  - merge.ts 两处 superseded 取代关系入链；tools.ts 检索结果显示 ↔关联N 条
  - 零工具 schema 变化零注入面变化（缓存安全）；单测：建链/幂等/自环/ADD 分支/无关不链
- 5.8 范围分层设计写入 ROADMAP: Tier1 非缓存面提示词（extract/summarizer/任务 prompt，
  零缓存成本，样本门槛 ≥10）可先行；Tier2 注入面维持 corrective≥50+golden 绿+命中率核算
- 过程教训（重要）:
  1. edit 生成笔误（b.links.push 误写 a.links.push）被新增单测当场拦截——防退化网价值实证；
     源码目检因预期偏差失效（眼睛自动纠正为预期写法），toString() 打印运行时函数体是
     定位"行为与源码目检不符"的决定性手段
  2. 测试数据设计: makeEntry 默认 content 全同 → storeEntry 内容 jaccard>0.7 走 merged
     分支、新条目未创建——fixture 必须内容差异化，否则测的是合并不是创建
- 回归: pi-memory vitest+tsc 绿；生产库无测试污染验证（665 条无测试 id）

---

## 2026-08-31 WikiSkill 借鉴：提案追踪闭环 + 执行-知识分离规则（ROADMAP 5.7 扩展）
- 状态: done
- 关联: WikiSkill arXiv:2608.27454 细读；ROADMAP 5.7 workticket 机制；VISION §3.4 新增

### Before
- lesson-course.json 只记主题+日期，不记结果；同主题优化建议可能被反复提出（无拒绝历史）；工单无 accepted/rejected/neutral 追踪，无法量化采纳率；VISION 无"执行与知识积累分离"原则（论文消融实证：Inference 训练期访问 wiki 使技能降质 63.7%→60.9%）。

### Change
- daily-review（seeds + 本机 scheduled-tasks 同步）步骤 4 重写：①生成 workticket 前查 lesson-course.json + workticket-*.md + OPTIMIZATION-LOG.md 去重（已提过无论结果如何不重复生成）；②lesson-course.json 记录主题/日期/状态；③工单验证回写三态 accepted|rejected|neutral（neutral 保留草稿供增量提案）；④清理规则：仅保留近 90 天、按主题去重。
- docs/VISION.md §3.3 后新增 §3.4 执行-知识分离软规则（用户已确认）。
- docs/SELF-OPTIMIZING-ROADMAP.md 追加记录 5.10 原子提案纪律（待工单样本≥10 条再实施）。

### After
- 待验证：seed 失配检查应转绿；明日 daily-review 运行后 lesson-course.json 首建，观察去重与三态回写是否按预期。回归：无扩展代码/脚本改动，test-all 不受影响。
- 结论：保留

---

## 2026-08-31 packs 草稿归置 + 记忆库内容域整理（828→798）
- 状态: done
- 关联: packs/README 流程（草稿确认机制）；VISION §5 内容域边界

### Before
- packs/drafts/ 积压 8 个草稿未处置；comfyui/colab/gamedev 无 EXPERIENCE.md
- 记忆库 828 条含 17 条项目域经验（ComfyUI/Colab/Phaser/gamedev/微信）+ 4 条 junk（test×3、记住数字 777）+ 7 组冲突重复 + 2 条与技能包重复的整合规范

### Change
- 草稿归置：repo-size-audit → 独立包 packs/repo-size-audit/；skill-integrate+skill-pack-adoption+external-skill-pack-integration → 合并为 packs/skill-integration/（选包/许可核对/审查/验收/三层归置/整合纪律）；miniprogram-dev → 并入 wechatide-skill（references/business-guide.md 已有完备覆盖，删除草稿）；webgame-autopilot → 并入 gamedev/references/webgame-autopilot.md + SKILL.md 路由；pi-voice-wake-debug → 并入 extensions/pi-voice/README.md Troubleshooting；daily-ops-review → 功能已被 daily-health 任务取代，删除
- 记忆迁移（按 VISION §5 内容域边界）：17 条项目域经验 → comfyui-agent/EXPERIENCE.md、colab-bridge/EXPERIENCE.md、gamedev/EXPERIENCE.md、wechatide LOCAL-NOTES.md + business-guide.md（云开发 vs 云托管选型），随后从 entries.json 删除（备份 /tmp/entries-backup-20260831-083716.json）
- 记忆清理：4 条 junk 删除；7 组冲突重复各保留较新/较完整侧；2 条外部技能包整合规范（内容已入 skill-integration）删除

### After
- packs/drafts/ 清空；新增 2 包（repo-size-audit/skill-integration）+ 4 个 EXPERIENCE.md/LOCAL-NOTES 增量
- 记忆库 828 → 798（-30）；用户偏好/环境类条目（ComfyUI 决策/Tetris 手感/游戏方向/小程序环境）保留未动
- 回归：无扩展代码改动；待明日 daily-review 运行确认 lesson-course 机制正常
- 结论：保留
