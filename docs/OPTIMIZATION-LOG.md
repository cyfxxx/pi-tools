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
